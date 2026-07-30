import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { QuadRenderer, quadMaterial } from './QuadPass.js';
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
 * WHY THE CONTACT TERM IS ESTIMATED IN ITS OWN TARGET, AND RESOLVED SPATIALLY.
 * --------------------------------------------------------------------------
 * The contact estimator is a 16-tap count. Divided by 16 and multiplied by
 * `contactIntensity` 2.5, then renormalised past the 0.12 pedestal, ONE tap
 * flipping moves the term by 2.5/16/0.88 = 0.177 — an 18 % luma step. So the
 * estimator's sampling variance is not a subtle grain, it is the loudest signal
 * in the frame, and the first version handed every pixel a DIFFERENT 16-tap
 * subset by rotating the spiral with `ign(gl_FragCoord)`. Measured on the
 * overworld moor (340x260 patch at 0.49,0.53, Nyquist checkerboard energy):
 * checker 0.0535 against 0.0513 with the whole pass off, at 0.53x its
 * brightness — i.e. the pass was ADDING per-pixel dither while removing value.
 * On `closeup` the same measurement read 0.0344 against 0.0168 with the pass
 * off: the pass was doubling the frame's per-pixel energy on its own. At 6x
 * zoom it was a newsprint halftone screen over every shadow in all eight
 * scenarios, which is the "aliasing crawl on high-contrast edges" flag.
 *
 * That variance also cost the frame a quarter of its VALUE, and this is the
 * part that is easy to miss. `pow(cao, 2.1)` is convex, so by Jensen's
 * inequality feeding it a noisy estimate biases the *mean* downward: the dither
 * was being rectified into a systematic darkening. Taking the mean before the
 * curve instead of after recovers moor mean 0.1064 -> 0.1308 and p99
 * 0.508 -> 0.569 with no change to any tuning constant.
 *
 * Neither turning the rotation off nor blurring the finished frame is the fix.
 * With no rotation the 16 azimuths are the same 16 for every pixel, so there is
 * nothing for a resolve to average and the fixed star pattern quantises the
 * term into plateaus — measured, that is WORSE than the interleave it replaces
 * (checker 0.0405 at jitter 0 against 0.0382 at jitter 1). And blurring the
 * frame is the one thing this defect must not be traded for. The variance has
 * to come down BEFORE the power curve, so:
 *
 *   1. Stage one writes the RAW obscurance (and the receiver's linear distance)
 *      into `contactTarget`, and rotates the spiral by SCREEN PARITY rather than
 *      per pixel: the four pixels of every 2x2 tile take four rotations that
 *      divide one azimuthal gap of the spiral, so a tile collectively samples
 *      4 x CONTACT_TAPS directions.
 *   2. Stage two resolves that with a 3x3 BINOMIAL TENT. The tent is not a
 *      taste choice — its weights (4,2,1)/16 give each of the four parity
 *      classes a total weight of exactly 1/4, so the interleave pattern cancels
 *      identically instead of leaving a 2x2 lattice behind, and the blur it
 *      costs is a 0.7 px radius on the occlusion term alone. Taps are rejected
 *      across a depth discontinuity so the resolve cannot pull a silhouette's
 *      occlusion onto the floor behind it: with the guard removed the flagstone
 *      immediately below the hero's boot on `closeup` loses 0.050 luma, which is
 *      a one-pixel halo — precisely the artefact contactAO's range check exists
 *      to prevent — while pixels 12 px away move by under 0.0013.
 *
 * Because the mean is taken BEFORE `pow`, the Jensen bias is not corrected
 * after the fact — it is never introduced. That is why this recovers the value
 * as well as the cleanliness: on open floor 12-50 px from the boot the resolved
 * term is up to 0.037 luma BRIGHTER than the unresolved one, not darker.
 *
 * A tempting alternative, and a trap: making the rotation constant over a 2x2
 * tile with no resolve drives the Nyquist checkerboard metric to nearly zero,
 * because the tile grid and the metric's 2x2 blocks are the same grid. It looks
 * perfect to the measurement and to the eye it is simply a coarser dot screen.
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

/* Shared by both stages: the tap count, and the view normal the estimator
 * orients itself by. */
const GLSL_CONTACT_COMMON = /* glsl */ `
#ifndef CONTACT_TAPS
#define CONTACT_TAPS 16
#endif
const float GOLDEN_ANGLE = 2.39996323;
const float TWO_PI = 6.28318531;

float depthAt( vec2 uv ) { return texture2D( tDepth, uv ).x; }

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
`;

/*
 * STAGE ONE — raw contact obscurance into R, receiver distance into G.
 *
 * Nothing non-linear happens here. The pedestal, the intensity and the power
 * curve all live in stage two, AFTER the spatial resolve, because every one of
 * them amplifies estimator variance and the whole point of the split is to take
 * the variance out first.
 */
const CONTACT_FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tDepth;
#ifdef SANCTUM_GB_NORMAL
uniform sampler2D tNormal;
#endif

uniform vec2  uTexel;
uniform vec2  uResolution;
uniform vec2  uProjScale;
uniform mat4  uInvProj;
uniform float uNear;
uniform float uFar;
uniform float uCRadius;
uniform float uCBias;
uniform float uCSlope;
uniform float uCRangeMul;
uniform float uCJitter;
uniform vec2  uCPx;
uniform float uCFar;

varying vec2 vUv;

${GLSL_CONTACT_COMMON}

/* Normal-oriented obscurance over a very small world radius. 0 = unoccluded.
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
void main() {
  float dRaw = depthAt( vUv );
  float dist = linearDist( dRaw, uNear, uFar );

  /* Sky occludes nothing, and past uCFar stage two fades the term out anyway —
   * skipping the taps there is most of the moor and all of the sky. */
  if ( dRaw >= 0.999999 || dist >= uCFar ) {
    gl_FragColor = vec4( 0.0, dist, 0.0, 1.0 );
    return;
  }

  vec3 P = viewPosFromDepth( vUv, dRaw, uInvProj );
  vec3 N = viewNormal( vUv, P );
  float z = max( -P.z, 1e-3 );

  // World radius -> uv radius, clamped in pixels so one setting works for a 3 m
  // portrait and a 28 m isometric camera. R is re-derived from the clamped
  // pixel radius so the range check always describes the disc actually sampled.
  vec2 rUv = ( 0.5 * uCRadius / z ) * uProjScale;
  float rPx = max( rUv.x * uResolution.x, rUv.y * uResolution.y );
  float px = clamp( rPx, uCPx.x, uCPx.y );
  float k = px / max( rPx, 1e-5 );
  rUv *= k;
  float range = uCRadius * k * uCRangeMul;

  /*
   * 2x2 INTERLEAVED ROTATION. The start angle is a function of SCREEN PARITY
   * alone, so it takes exactly four values across the frame and every 2x2 tile
   * holds one of each. Those four values divide one mean azimuthal gap of the
   * spiral (TWO_PI / CONTACT_TAPS), so the tile as a whole samples 4x as many
   * directions as a pixel does, and stage two's tent — which weights the four
   * parity classes equally — reads that full set back out.
   *
   * This is the same decorrelation the old per-pixel ign() rotation was for,
   * with the difference that a per-pixel rotation is unrecoverable: it leaves
   * every pixel holding an independent estimate, which is precisely the dither.
   * uCJitter scales the spread; at 0 the spiral is unrotated and quantises into
   * plateaus, at 1 the four classes tile the gap exactly.
   */
  float cls = mod( floor( gl_FragCoord.x ), 2.0 ) + 2.0 * mod( floor( gl_FragCoord.y ), 2.0 );
  float rot = cls * ( TWO_PI / float( CONTACT_TAPS ) ) * 0.25 * uCJitter;

  float occ = 0.0;

  for ( int i = 0; i < CONTACT_TAPS; i ++ ) {
    float fi = ( float( i ) + 0.5 ) / float( CONTACT_TAPS );
    float a = rot + float( i ) * GOLDEN_ANGLE;
    // pow 0.7 rather than the area-uniform sqrt: taps are pulled toward the
    // centre, where the contact signal lives, which both tightens the seam and
    // cuts the sample variance that shows up as dither on the ground.
    vec2 suv = vUv + vec2( cos( a ), sin( a ) ) * rUv * pow( fi, 0.7 );
    if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;

    float sd = depthAt( suv );
    if ( sd >= 0.999999 ) continue;                 // Sky occludes nothing.

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

  gl_FragColor = vec4( occ / float( CONTACT_TAPS ), dist, 0.0, 1.0 );
}
`;

/* STAGE TWO — resolve, shape and apply both occlusion terms to the frame. */
const APPLY_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BILATERAL}

uniform sampler2D tDiffuse;
uniform sampler2D tAO;
// NOTE: three's program prefix already emits "precision highp sampler2D",
// so this is a full-precision depth fetch without an explicit qualifier
// (which would clash with the shared bilateral helper's sampler2D parameter).
uniform sampler2D tDepth;
uniform sampler2D tContact;
#ifdef SANCTUM_GB_NORMAL
uniform sampler2D tNormal;
#endif

uniform vec2  uAoTexel;
uniform vec2  uTexel;
uniform vec2  uResolution;
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
uniform float uCOn;          // 0 when the contact target was not rendered.
uniform float uCIntensity;
uniform float uCPower;
uniform float uCKnee;
uniform float uCFloor;
uniform float uCProtect;
uniform float uCProtKnee;
uniform float uCFar;
uniform float uCDenoise;     // 0 = raw per-pixel estimate, 1 = full tent resolve.
uniform float uCTol;         // Resolve depth tolerance, fraction of receiver distance.
uniform int   uDebug;

varying vec2 vUv;

/* Emissive-only occlusion protection. Returns 1 (occlude fully) for everything
 * below the knee — however brightly a DIRECT light is hitting it — and rolls off
 * above it, where the only things that live are flame cores, hot metal, runes and
 * spell VFX. See the header note. */
float protectAt( float l, float knee, float k ) {
  return 1.0 / ( 1.0 + k * max( l - knee, 0.0 ) );
}

/*
 * 3x3 BINOMIAL TENT over the RAW obscurance — the partner of stage one's 2x2
 * interleave, and the whole reason this pass is split in two.
 *
 * The weights are (4,2,1)/16. That is not a taste choice: in a 3x3 window the
 * centre pixel's own parity class appears once, the two x-neighbours share a
 * second class, the two y-neighbours a third and the four corners the fourth,
 * so 4/16 + 2*2/16 + 2*2/16 + 4*1/16 gives every class a total of exactly 1/4.
 * The interleave therefore cancels *identically* rather than leaving a residual
 * 2x2 lattice, and the price is a 0.7 px blur of the occlusion term alone —
 * never of the frame.
 *
 * Taps are weighted down across a depth discontinuity, because a pixel of boot
 * must not lend its occlusion to the flagstone behind it. The tolerance is a
 * FRACTION of the receiver's distance rather than a fixed number of metres: at
 * 2 m on the closeup framing a grazing flagstone moves ~3 mm per pixel and a
 * boot edge ~0.2 m, and at 28 m both scale with the frustum, so one relative
 * number covers every framing the game has. Renormalising by the accepted
 * weight is what keeps the magnitude right where taps are rejected.
 */
float resolveContact( vec2 uv, float dc ) {
  float raw = texture2D( tContact, uv ).x;
  if ( uCDenoise <= 0.0 ) return raw;

  float tol = uCTol * max( dc, 0.5 );
  float acc = 0.0;
  float wsum = 0.0;
  for ( int j = -1; j <= 1; j ++ ) {
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 s = texture2D( tContact, uv + vec2( float( i ), float( j ) ) * uTexel ).xy;
      float tw = ( i == 0 ? 2.0 : 1.0 ) * ( j == 0 ? 2.0 : 1.0 );
      float w = tw * exp( -abs( s.y - dc ) / tol );
      acc += s.x * w;
      wsum += w;
    }
  }
  return mix( raw, acc / max( wsum, 1e-5 ), uCDenoise );
}

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float dRaw = texture2D( tDepth, vUv ).x;

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

  /*
   * --- contact occlusion, full res, ~0.1-0.2 m ---
   * Resolve FIRST, then the pedestal, then the power curve. Both of those are
   * variance amplifiers — the pedestal divides by 0.88 and the curve is convex,
   * which rectifies noise into a systematic darkening — so the order here is
   * the fix, not an implementation detail.
   */
  float cao = 1.0;
  if ( uCOn > 0.5 ) {
    float o = resolveContact( vUv, centerDist ) * uCIntensity;

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
    cao = pow( sat( 1.0 - o ), uCPower );

    // Fade out with distance: past uCFar the sphere is sub-pixel and all it can
    // add is aliasing on the horizon.
    float far = 1.0 - smoothstep( uCFar * 0.72, uCFar, centerDist );
    cao = mix( 1.0, cao, far );
    cao = max( cao, uCFloor );
  }

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
  if ( uDebug == 4 ) {
#ifdef SANCTUM_GB_NORMAL
    vec3 N = texture2D( tNormal, vUv ).xyz * 2.0 - 1.0;
    gl_FragColor = vec4( normalize( N ) * 0.5 + 0.5, base.a );
#else
    gl_FragColor = vec4( 0.5, 0.5, 1.0, base.a );
#endif
    return;
  }

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
  /*
   * Spread of the 2x2 interleaved start angle, in mean azimuthal gaps of the
   * spiral. 1 = the four parity classes tile one gap exactly, which is what
   * makes the tile cover 4 x CONTACT_TAPS directions. It replaces the old 0.5
   * per-pixel `ign()` rotation — see the header for why per-pixel was the
   * whole defect.
   */
  contactJitter: 1.0,
  contactKnee: 0.12,
  contactFloor: 0.06,
  contactProtect: 0.55,
  contactMinPx: 2.0,
  contactMaxPx: 72.0,
  contactFar: 90.0,
  /** 1 = resolve the estimate over the 2x2 tile, 0 = raw per-pixel (diagnostic). */
  contactDenoise: 1.0,
  /**
   * Resolve depth tolerance as a fraction of the receiver's distance. 2 % is
   * two orders of magnitude above the per-pixel depth change of a floor seen at
   * 60 degrees and an order below a silhouette step, at every framing.
   */
  contactResolveTol: 0.02,
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
 *
 * The contact term is estimated into `contactTarget` with a screen-parity
 * interleaved spiral and resolved with a class-balanced 3x3 tent before any
 * non-linearity touches it — see the header for the measurements that forced
 * that split.
 */
export class AOApplyPass extends Pass {
  constructor({ aoTexture, depthTexture, normalTexture = null, camera, params, taps = 16 }) {
    super();
    this.camera = camera;
    this.params = params;
    this.needsSwap = true;
    this._quad = new QuadRenderer();

    const defines = { CONTACT_TAPS: Math.max(4, Math.min(32, taps | 0)) };
    if (normalTexture) defines.SANCTUM_GB_NORMAL = 1;

    /*
     * RG16F, point sampled: R is the raw obscurance and G the receiver's linear
     * distance, which is what lets the resolve reject a tap across a silhouette
     * from ONE fetch instead of a second depth fetch per tap. Point sampling is
     * correct as well as cheap — the target is the size of the frame, so every
     * tap in the tent lands on a texel centre.
     */
    this.contactTarget = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.contactTarget.texture.name = 'Sanctum.contactAO';

    this.contactMaterial = quadMaterial(
      'Sanctum.ContactAO',
      CONTACT_FRAG,
      {
        tDepth: { value: depthTexture },
        tNormal: { value: normalTexture },
        uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
        uResolution: { value: new THREE.Vector2(1600, 900) },
        uProjScale: { value: new THREE.Vector2(1.5, 2.75) },
        uInvProj: { value: new THREE.Matrix4() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uCRadius: { value: D.contactRadius },
        uCBias: { value: D.contactBias },
        uCSlope: { value: D.contactSlope },
        uCRangeMul: { value: D.contactRangeMul },
        uCJitter: { value: D.contactJitter },
        uCPx: { value: new THREE.Vector2(D.contactMinPx, D.contactMaxPx) },
        uCFar: { value: D.contactFar },
      },
      defines
    );

    this.material = quadMaterial(
      'Sanctum.AOApply',
      APPLY_FRAG,
      {
        tDiffuse: { value: null },
        tAO: { value: aoTexture },
        tDepth: { value: depthTexture },
        tContact: { value: this.contactTarget.texture },
        tNormal: { value: normalTexture },
        uAoTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
        uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
        uResolution: { value: new THREE.Vector2(1600, 900) },
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
        uCOn: { value: 1 },
        uCIntensity: { value: D.contactIntensity },
        uCPower: { value: D.contactPower },
        uCKnee: { value: D.contactKnee },
        uCFloor: { value: D.contactFloor },
        uCProtect: { value: D.contactProtect },
        uCProtKnee: { value: D.contactProtectKnee },
        uCFar: { value: D.contactFar },
        uCDenoise: { value: D.contactDenoise },
        uCTol: { value: D.contactResolveTol },
        uDebug: { value: 0 },
      },
      defines
    );
    // The apply stage's uniforms are the pass's public surface, as before.
    this.uniforms = this.material.uniforms;
  }

  setAoResolution(w, h) {
    this.uniforms.uAoTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
  }

  setSize(width, height) {
    const w = Math.max(2, Math.round(width));
    const h = Math.max(2, Math.round(height));
    this.width = w;
    this.height = h;
    this.contactTarget.setSize(w, h);
    for (const m of [this.contactMaterial, this.material]) {
      m.uniforms.uResolution.value.set(w, h);
      m.uniforms.uTexel.value.set(1 / w, 1 / h);
    }
  }

  render(renderer, writeBuffer, readBuffer) {
    const p = this.params;
    const cam = this.camera;
    const cu = this.contactMaterial.uniforms;
    const u = this.uniforms;

    const cIntensity = p.contactIntensity ?? D.contactIntensity;
    // Contact term off: skip the estimator draw outright rather than filling a
    // full-res target with zeroes, and tell stage two to ignore it.
    const contactOn = cIntensity > 0 && (p.contactRadius ?? D.contactRadius) > 0;

    // `projectionMatrix` elements 0 and 5 turn a world offset at view depth z
    // into an NDC offset, which is how a metre radius becomes a pixel radius
    // without ever leaving the shader's own space.
    const e = cam.projectionMatrix.elements;
    cu.uProjScale.value.set(Math.abs(e[0]), Math.abs(e[5]));
    cu.uInvProj.value.copy(cam.projectionMatrixInverse);
    cu.uNear.value = cam.near;
    cu.uFar.value = cam.far;
    cu.uCRadius.value = p.contactRadius ?? D.contactRadius;
    cu.uCBias.value = p.contactBias ?? D.contactBias;
    cu.uCSlope.value = p.contactSlope ?? D.contactSlope;
    cu.uCRangeMul.value = p.contactRangeMul ?? D.contactRangeMul;
    cu.uCJitter.value = p.contactJitter ?? D.contactJitter;
    cu.uCPx.value.set(p.contactMinPx ?? D.contactMinPx, p.contactMaxPx ?? D.contactMaxPx);
    cu.uCFar.value = p.contactFar ?? D.contactFar;

    u.tDiffuse.value = readBuffer.texture;
    u.uInvProj.value.copy(cam.projectionMatrixInverse);
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    u.uIntensity.value = p.aoIntensity;
    u.uPower.value = p.aoPower;
    u.uMinAO.value = p.aoFloor;
    u.uLumaProtect.value = p.aoLumaProtect;
    u.uProtKnee.value = p.aoProtectKnee ?? D.aoProtectKnee;
    u.uAoColor.value.setRGB(p.aoColor[0], p.aoColor[1], p.aoColor[2]);
    u.uCOn.value = contactOn ? 1 : 0;
    u.uCIntensity.value = cIntensity;
    u.uCPower.value = p.contactPower ?? D.contactPower;
    u.uCKnee.value = p.contactKnee ?? D.contactKnee;
    u.uCFloor.value = p.contactFloor ?? D.contactFloor;
    u.uCProtect.value = p.contactProtect ?? D.contactProtect;
    u.uCProtKnee.value = p.contactProtectKnee ?? D.contactProtectKnee;
    u.uCFar.value = p.contactFar ?? D.contactFar;
    u.uCDenoise.value = p.contactDenoise ?? D.contactDenoise;
    u.uCTol.value = p.contactResolveTol ?? D.contactResolveTol;
    u.uDebug.value = p.aoDebug ?? 0;

    if (contactOn) this._quad.render(renderer, this.contactMaterial, this.contactTarget);
    this._quad.render(renderer, this.material, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.contactTarget.dispose();
    this.contactMaterial.dispose();
    this.material.dispose();
    this._quad.dispose();
  }
}
