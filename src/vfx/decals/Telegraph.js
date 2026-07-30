/**
 * THE NINTH VIGIL — ground attack telegraphs.
 *
 * These are gameplay-critical: the player has to read shape, extent and timing
 * in a fraction of a second at a 28 m camera distance. So they are NOT bitmaps.
 * Every circle, ring, cone and line is an analytic signed distance field
 * evaluated in the fragment shader with `fwidth` antialiasing, which means:
 *
 *   • edges stay pixel-crisp at any distance and any zoom, never blurred by a
 *     mip level or stretched by a 21 m long projector,
 *   • the rim thickness is specified in METRES, so the read is consistent
 *     whatever the size of the ability,
 *   • zero textures — the whole system costs 0 of the 16 fragment texture units,
 *   • one merged geometry, ONE DRAW CALL for up to 14 simultaneous telegraphs.
 *
 * The geometry is still a ground-conforming subdivided patch, so a cone crossing
 * a stair or a slope hugs it instead of slicing through.
 *
 * The fill sweeps from origin to extent over the windup, with a bright leading
 * front and a resolve flash on release — timing is legible without a HUD.
 *
 * EXPOSURE BUDGET (this is what keeps a telegraph from eating the frame)
 * ---------------------------------------------------------------------
 * The field draws into the pipeline's LINEAR HDR buffer, upstream of
 * auto-exposure and of UnrealBloom. Writing ~1.0 linear lands at ~1.0 x gain
 * after exposure, and past the bloom threshold and the ACES shoulder that is a
 * clipped white shape with a halo. Every gain below is budgeted against a
 * REFERENCE gain of 1.85x, and the light layers are authored as DISPLAY
 * LUMINANCES against the whole post chain — L_RIM 0.078, L_FRONT 0.060 — with a
 * safety rail above them for stacking. A telegraph is legible. A telegraph never
 * blooms and never outranks the hero.
 *
 * The live gain is NOT 1.85x. The grade pass authors an exposure ceiling per
 * scenario and the effective gains measured 1.78x (`overworld`) to 3.30x
 * (`inventory`); at the boss arena's 2.73x this ceiling reached 1.91, over the
 * bloom threshold, and the read clipped. So RenderPipeline publishes
 * `engine.vfxExposureNorm` (= 1.85 / live gain) and the final colour is scaled
 * by it, which holds the telegraph at the DISPLAY level it was authored for no
 * matter how hard the scene had to be pushed to meter. A danger read is a read,
 * not a lit surface, so display-referred is the correct frame of reference.
 *
 * DEPTH-AWARE PROJECTION (round-5 blocker #3)
 * -------------------------------------------
 * Conforming geometry plus `depthTest` is NOT the same thing as a projected
 * decal, and the difference was visible: the patch follows the ANALYTIC ground
 * height, `polygonOffset -5/-10` biased it toward the camera hard enough to win
 * against small occluders, and every fragment that landed on a wall base, a
 * rubble slab, a barrel or a character's shin was still drawn — so the field read
 * as an overlay pasted on the frame rather than light lying on the floor.
 *
 * It now does what a deferred decal does. The shared G-buffer prepass
 * (`RenderPipeline.gbuffer`) already holds this frame's SOLID depth, rendered
 * with the same camera immediately before the beauty pass, and the telegraph is
 * excluded from it (`depthWrite:false`). So each fragment:
 *
 *   1. takes its own screen position from the interpolated clip coordinate — no
 *      resolution uniform, so it is exact whatever the render scale,
 *   2. samples that depth, unprojects it through `clipToWorld` (camera world
 *      matrix x inverse projection) to the WORLD point the scene actually has at
 *      that pixel,
 *   3. compares that point with its own world position and fades out as the two
 *      disagree — vertically, and laterally for grazing receivers.
 *
 * A fragment over the hero's chest, a column, a wall or the sky reconstructs
 * metres away from the decal surface and is rejected; a fragment over the floor's
 * own relief reconstructs within centimetres and is kept. `polygonOffset` drops
 * to a hairline (-1/-2) because the depth test no longer has to be cheated, and
 * the field is genuinely occluded by geometry instead of drawn above it.
 *
 * When the tier has no G-buffer (`low`) or nothing enabled it this frame,
 * `uDepthOn` goes to 0 and the field degrades to the old behaviour rather than
 * vanishing.
 *
 * STROKE PROFILE
 * --------------
 * The outline is not one band. Three lobes measured off the same SDF sum into it:
 * a thin bright CORE (the gameplay read), a wide quadratic SPILL (the outer soft
 * edge), and a one-sided INWARD gradient. Each is floored against `fwidth` so
 * none can fall under a pixel, and because only the core is bright the total
 * light does not grow with the stroke's apparent width. That is what a real
 * width falloff is, and it is the opposite of the uniform 4 px stroke this
 * replaces.
 *
 * Blending is premultiplied alpha (ONE, ONE_MINUS_SRC_ALPHA). `dst * (1 - a)` is
 * a pure multiply, so the floor's texture and its contrast ratio survive under
 * the fill and only the tint is added on top — the read darkens and warms the
 * stone instead of painting over it. It also lets a 2%-bright wash and a
 * 62%-bright rim share a fragment without averaging into a milky middle.
 *
 * The composite splits SHADOW layers from LIGHT layers for exactly that reason:
 * shadow layers occlude at their coverage, light layers occlude at a quarter of
 * it, so a rim adds light without erasing the flagstone it lies on. Every
 * boundary is additionally warped and eroded by procedural noise and scrolled by
 * a flow field, because a constant-value stroke of constant width on a perfect
 * analytic circle is 1-bit line art no matter how dim you make it.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;
const SLOTS = 14;
const RES = 20;                    // 21x21 verts per slot
const VPS = (RES + 1) * (RES + 1);
const IPS = RES * RES * 6;
const PAD = 0.5;                   // metres of skirt for the outer glow
const LIFT = 0.032;

const KIND = { circle: 0, ring: 1, cone: 2, line: 3 };
const DANGER = { light: 0.86, medium: 1.0, heavy: 1.18, aoe: 1.06 };

/**
 * Metres of disagreement between the decal surface and the reconstructed scene
 * surface that still counts as "the same floor". Sized off the worst analytic /
 * rendered mismatch this project actually has (KNOWN_ISSUES measures up to 0.4 m
 * around rubble), with the fade running to 2.4x that — so the floor's own relief
 * is accepted and a shin, a slab lip, a wall base or the sky is not.
 */
const PROJ_THICK = 0.55;

/**
 * Hues. A telegraph is a DANGER READ, so its colour has to carry information:
 * the element that is about to land, or the rarity of the thing casting it.
 * Everything here is one saturated accent per family — never a rainbow — and the
 * shader normalises whatever arrives to unit luminance, so switching hue changes
 * the colour of the read and never its brightness.
 */
const ELEMENT_HUE = {
  fire: 0xff5a1e, hellfire: 0xff4412, flame: 0xff5a1e, burn: 0xff4a16,
  frost: 0x6ecbff, ice: 0x6ecbff, cold: 0x6ecbff,
  arcane: 0xa46bff, shadow: 0x8a56ff, void: 0x7b45ff,
  necrotic: 0x7fdc5e, poison: 0x9cd93c, plague: 0x8fce4a,
  holy: 0xffd79a, light: 0xffe0ad,
  lightning: 0x9fd4ff, storm: 0x8fc6ff,
  blood: 0xff2f36, physical: 0xff8a3c,
};
const RARITY_HUE = {
  common: 0xd7d2c8, magic: 0x6f9bff, rare: 0xffd24a,
  legendary: 0xff8a2b, unique: 0xd6392a, mythic: 0x9a4bff,
};
/**
 * Default accent by how hard the attack hits, when nothing else is declared.
 *
 * Deliberately a narrow amber -> hot-orange ramp rather than amber -> blood red.
 * The arenas these land in are themselves warm (hellfire in `boss`, torchlight in
 * the crypt), and a deeply red read on a red-lit floor loses the value AND the hue
 * separation it needs to be legible in a fraction of a second. Hot orange keeps
 * "this is about to hurt" while staying a stop away from the floor's own hue.
 * `element` overrides this whenever the caster knows better.
 */
const DANGER_HUE = {
  light: 0xffb066, medium: 0xff7a24, heavy: 0xff5518, aoe: 0xff8f2c,
};

const VERT = /* glsl */`
attribute vec2 aLocal;
attribute vec4 aT1;
attribute vec4 aT2;
attribute vec4 aT3;
attribute vec4 aT4;
varying vec2 vLocal;
varying vec3 vWorld;
varying vec4 vClip;
varying vec4 vT1;
varying vec4 vT2;
varying vec4 vT3;
varying vec4 vT4;
void main() {
  vLocal = aLocal;
  vT1 = aT1; vT2 = aT2; vT3 = aT3; vT4 = aT4;
  /* The patch is baked in world space and the mesh matrix is identity, so
     'position' IS the world position — which is what the depth-projection test
     downstream compares the reconstructed scene point against. */
  vWorld = position;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mv;
  /* Carry the clip coordinate so the fragment can find its own screen UV by
     perspective divide. No resolution uniform, therefore exact at any render
     scale and correct even when the G-buffer is a different size. */
  vClip = gl_Position;
}
`;

const FRAG = /* glsl */`
precision highp float;
// NOTE: three's fragment prefix already injects <tonemapping_pars_fragment> and
// <colorspace_pars_fragment>; including them again is a redefinition error.
#include <common>
uniform float uTime;
// 1.85 / live exposure gain. 1.0 means the pipeline is at the reference
// gain that every L_RIM/WASH number below was budgeted against.
uniform float uExpNorm;
/* --- depth-aware projection ------------------------------------------------
   uDepth       the shared G-buffer's hardware depth for THIS frame, solid
                geometry only (the telegraph itself is excluded from it).
   uClipToWorld camera.matrixWorld * camera.projectionMatrixInverse — takes an
                NDC point straight to the world point the scene has there.
   uDepthOn     0 when the tier has no G-buffer or nothing rendered it this
                frame; the field then degrades instead of disappearing.
   uThick       metres of surface disagreement still accepted as "same floor". */
uniform sampler2D uDepth;
uniform mat4 uClipToWorld;
uniform float uDepthOn;
uniform float uThick;
varying vec2 vLocal;
varying vec3 vWorld;
varying vec4 vClip;
varying vec4 vT1;   // kind, radius, inner, length
varying vec4 vT2;   // width, halfAngle, t0, duration
varying vec4 vT3;   // colour rgb, danger
varying vec4 vT4;   // endTime, released, seed, opacity

/* Gain budget — MEASURED against the whole post chain, not authored by eye.
 *
 * The old ceiling was a per-channel clamp at 0.70 in scene units, and both halves
 * of that were wrong:
 *
 *  • PER-CHANNEL. An orange rim railed red first and let green climb behind it,
 *    so the hue died and every read resolved as pale cream line art. The light
 *    colour is now normalised to unit LUMINANCE and the gains are luminances, so
 *    hue survives and a saturated orange and a pale cyan read at the same level.
 *  • SCENE UNITS. The grade pass is strongly expansive — the crypt look runs
 *    blackPoint 0.028 / whitePoint 0.72 / contrast 1.38 about pivot 0.44, a ~3x
 *    lift on midtones. 0.30 HDR luma through exposure(1.87) -> ACES -> sRGB ->
 *    grade lands at 253/255. That is the whole "pure-white line art" defect: the
 *    ceiling was set upstream of a chain that then multiplied it into the rail.
 *
 * Solved backwards from a target instead: L_RIM 0.078 measures ~122/255 on crypt
 * flagstones — a legible warm rim that sits BELOW the lit stone next to it and
 * far below the hero's highlights. RING_LUM / AREA_LUM are SAFETY RAILS set well
 * above the authored peak: as limiters they flattened every modulated pixel onto
 * one value and put the constant-brightness stroke straight back. */
#define RING_LUM 0.115       /* SAFETY RAIL only — see L_RIM for the authored level */
#define AREA_LUM 0.050       /* safety rail for an area fill                        */
#define L_RIM   0.078        /* authored peak LUMINANCE of the outline              */
#define L_FRONT 0.060        /* authored peak luminance of the sweeping front       */
#define WASH   0.130         /* interior tint gain: a cast over the floor, not paint */
#define STREAK 0.20          /* hazard streak gain                                 */
#define SHADE  0.012         /* engraved shadow line gain (near black)             */
#define BLEED  0.020         /* outer contact shade gain (near black)              */

/* Value noise. Zero textures — the whole field still costs 0 texture units — and
 * a pure function of local position, so it is byte-deterministic across runs. */
float tgHash( vec2 p ) {
  p = fract( p * vec2( 443.8975, 397.2973 ) );
  p += dot( p, p + 19.19 );
  return fract( ( p.x + p.y ) * p.x );
}
float tgNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( tgHash( i ), tgHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( tgHash( i + vec2( 0.0, 1.0 ) ), tgHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float tgFbm( vec2 p ) {
  float a = 0.5, s = 0.0, n = 0.0;
  for ( int i = 0; i < 3; i++ ) { s += tgNoise( p ) * a; n += a; p *= 2.03; a *= 0.5; }
  return s / n;
}

/* Signed distance to the lane, spanning x in [0,len], |y| <= w — as a ROUNDED
 * stadium, never a box.
 *
 * TWO BUGS THIS REPLACES, in the order they were found, because between them
 * they are the whole "giant white shape across the frame" defect:
 *
 * 1. SOLID SLAB. The original form built q.x as ( p.x - clamp( p.x, 0.0, len ) ),
 *    which is exactly 0.0 everywhere along the span. That makes
 *    max( q.x, q.y ) >= 0 for every interior fragment, so the interior term
 *    min( max( q.x, q.y ), 0.0 ) collapses to 0 and the function returns
 *    d == 0.0 across the ENTIRE lane instead of a negative interior distance.
 *    Every |d|-driven term then fired at full strength over the whole rectangle
 *    and a 21 m x 3.4 m boss-charge lane painted as a solid, near-opaque slab.
 *
 * 2. WIREFRAME BOX. Fixing (1) to a correct signed *box* traded the slab for a
 *    hard-edged hollow rectangle: a 0.06 m constant-metre rim is ~2 px at a 28 m
 *    camera, so a 17 m lane became two dead-straight 540 px white hairlines
 *    ( the 'X' over the night moor ) and the 21 m boss charge became an
 *    axis-aligned wireframe quad through the arena centre. A rectangle with
 *    square corners, a constant-brightness outline and a full-area interior
 *    darkening cannot read as anything but broken geometry. The lane branch in
 *    main() now answers all three: rounded caps and corners (here), a soft
 *    width-relative shoulder instead of a hairline rim, a spine-weighted fill
 *    that decays to nothing at the flanks, and an along-length dissipation that
 *    feathers both caps. No straight hard edge survives anywhere on it.
 *
 * Here b is the half-extent about the origin and r the corner radius. Negative
 * inside, positive outside, exact at the rounded corners.
 */
float sdRoundBox( vec2 p, vec2 b, float r ) {
  vec2 q = abs( p ) - b + r;
  return length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - r;
}

/* ---------------------------------------------------------------------------
 * PROJECTION TEST — the thing that makes this a decal rather than an overlay.
 *
 * Unproject this pixel's SOLID scene depth to a world point and compare it with
 * the fragment's own world position. Two measures, because the two failure modes
 * are different:
 *
 *   dv  vertical disagreement. A shin, a chest, a slab lip, a wall base or a
 *       column all sit metres above the floor the decal is projected onto, and
 *       this is what rejects them.
 *   dh  lateral slide. On a receiver seen at a grazing angle a fraction of a
 *       pixel of sampling offset (the G-buffer may be at 0.55x on 'med') is a
 *       large slide along the ground, which is real but must not be read as a
 *       different surface — hence the 0.6 weight.
 *
 * Depth exactly at the far plane means the prepass drew NOTHING here: sky, or a
 * hole in the world. A ground decal has no receiver there, so it is rejected
 * outright rather than smeared over the horizon.
 *
 * Returns 1 on the decal's own surface, falling smoothly to 0 as the scene
 * surface walks away from it. A hard cut would alias along every silhouette.
 */
float projectionWeight() {
  if ( uDepthOn < 0.5 ) return 1.0;
  vec2 suv = ( vClip.xy / vClip.w ) * 0.5 + 0.5;
  if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) return 1.0;
  float dz = texture2D( uDepth, suv ).x;
  if ( dz >= 0.999995 ) return 0.0;
  vec4 hp = uClipToWorld * vec4( suv * 2.0 - 1.0, dz * 2.0 - 1.0, 1.0 );
  vec3 sceneW = hp.xyz / max( abs( hp.w ), 1e-6 ) * sign( hp.w );
  float dv = abs( sceneW.y - vWorld.y );
  float dh = length( sceneW.xz - vWorld.xz );
  float gap = max( dv, dh * 0.60 );
  return 1.0 - smoothstep( uThick, uThick * 2.4, gap );
}

void main() {
  float kind = vT1.x;
  float R = vT1.y, IN = vT1.z, LEN = vT1.w;
  float W = vT2.x, HA = vT2.y, T0 = vT2.z, DUR = max( 0.06, vT2.w );
  float endT = vT4.x, released = vT4.y, seed = vT4.z, master = vT4.w;
  if ( master <= 0.0 ) discard;

  /* Reject fragments the scene does not actually have a floor for, before any of
     the field is evaluated. */
  float proj = projectionWeight();
  if ( proj <= 0.004 ) discard;

  float t = uTime - T0;
  float prog = clamp( t / DUR, 0.0, 1.0 );

  vec2 p = vLocal;
  float rr = length( p );
  float d, fillT;
  float lane = 1.0;                 // along-shape weighting, lanes only
  float spine = 1.0;                // across-width weighting, lanes only
  float bleedIn = 1.0;              // interior share of the outer contact shade
  float grooveOn = 1.0;             // engraved scribe line, non-lanes only
  float rimGain = 1.0;              // rim brightness scale
  float rimCov = 0.94;              // rim coverage scale
  float rimBand = 0.060;            // rim half-thickness, metres
  float rimPlateau = 0.40;          // fraction of the band held at full value
  float frontM = 1.0;               // sweep-front gain scale
  float fillM = 1.0;                // interior-tint coverage scale

  if ( kind < 0.5 ) {                       // filled circle
    d = rr - R;
    fillT = rr / max( 0.001, R );
  } else if ( kind < 1.5 ) {                // ring / donut
    float mid = 0.5 * ( R + IN );
    float band = max( 0.02, 0.5 * ( R - IN ) );
    d = abs( rr - mid ) - band;
    fillT = clamp( ( rr - IN ) / max( 0.001, R - IN ), 0.0, 1.0 );
  } else if ( kind < 2.5 ) {                // cone / cleave
    float ang = atan( p.y, p.x );
    float da = ( abs( ang ) - HA ) * max( rr, 0.12 );
    d = max( rr - LEN, da );
    fillT = rr / max( 0.001, LEN );
  } else {                                  // line / charge lane
    // W is the lane's full width, so the SDF gets half of it.
    float hw = max( W * 0.5, 0.02 );
    /* Rounded caps and corners. A square-cornered 21 m rectangle is read as
       geometry, not as a danger field, no matter how it is shaded. */
    float cr = min( hw * 0.94, LEN * 0.11 );
    d = sdRoundBox( vec2( p.x - LEN * 0.5, p.y ), vec2( LEN * 0.5, hw ), cr );
    fillT = clamp( p.x / max( 0.001, LEN ), 0.0, 1.0 );

    /* Across the width: a gaussian on the spine that decays to nothing at the
       flanks, so the silhouette has no hard side. */
    float ay = abs( p.y ) / hw;
    spine = exp( -ay * ay * 1.35 );
    /* Along the length: a lane is a threat emanating FROM the caster, so it
       dissipates outward and feathers at both caps. This is what stops a 21 m
       charge from reading as a bar drawn across the arena — the far half is a
       hint, the near half is the warning. */
    lane = ( 1.0 - 0.58 * fillT )
      * smoothstep( 0.0, 0.06, fillT )
      * ( 1.0 - smoothstep( 0.88, 1.0, fillT ) );
    /* No full-area darkening under a 21 m footprint: the contact shade belongs
       at the boundary, and over a bright floor a 0.15-alpha interior wash was
       itself half of the "hard-edged quad" read. */
    bleedIn = 0.0;
    grooveOn = 0.0;
    /* A soft shoulder scaled to the lane's own width, not a 6 cm hairline —
       and dimmer the longer the lane, so length never buys brightness. */
    rimBand = min( hw * 0.62, 0.55 );
    rimPlateau = 0.0;
    rimGain = 0.90 / ( 1.0 + LEN * 0.055 );
    rimCov = 0.68;
    /* The sweep front is the brightest thing on a lane and on a 17 m one it is a
       4 m long hot patch. Halve it: the read is carried by the tint and the
       shoulder, not by a blown highlight sliding down the frame. */
    frontM = 0.50;
    /* ...and put the difference back into the tint, so a lane still darkens and
       warms the ground it threatens even when it is drawn over blown stone. */
    fillM = 1.70;
  }

  float aa = max( fwidth( d ), 1e-4 );
  float inside = 1.0 - smoothstep( -aa, aa, d );

  /* --- erosion + flow ---------------------------------------------------
     A danger read is light scouring across stone, not a vector stroke laid on
     top of it. Two coupled procedural fields do that, both pure functions of
     local position and uTime so the frame stays byte-deterministic:

       wear  pits the boundary and eats its coverage, so no edge of the outline
             is geometrically clean at any zoom,
       flow  scrolls charge along the shape, so the rim is never uniformly lit
             around its own length — which is the single tell that separates
             "authored magic" from "debug gizmo".

     Both are cheap value noise; the field still binds zero textures. */
  float ero  = tgFbm( p * 2.55 + vec2( seed * 37.0, seed * 19.0 ) );
  float fine = tgNoise( p * 9.7 + vec2( seed * 13.0, -seed * 7.0 ) );
  float flow = tgFbm( p * 1.45 + vec2( uTime * 0.23, -uTime * 0.15 ) + seed * 5.0 );
  float wear = clamp( 0.26 + ero * 1.22 - fine * 0.24, 0.0, 1.0 );

  /* --- outline: constant-metre rim, floored at a pixel so it never vanishes.
         Thin is the point for a closed shape — a rim-heavy read costs almost no
         exposure. Lanes widen and soften it instead (above): a 2 px full-value
         line 500 px long is a wireframe, a 16 px gradient is a glowing edge. */
  float rimW = max( rimBand, aa * ( rimPlateau > 0.0 ? 1.6 : 2.5 ) );
  /* Warp the boundary the rim is measured against — a couple of centimetres of
     noise — so the outline meanders like a scoured channel instead of tracing a
     perfect analytic circle. The shape's own extent (the inside term) is left
     exact so the gameplay read is unchanged. */
  float dW = d + ( ero - 0.5 ) * rimW * 1.25;

  /* --- STROKE PROFILE: three lobes, not one band -------------------------
   *
   * The defect this replaces is exactly "uniform-width line art": a single
   * one 1 - smoothstep( rimW * plateau, rimW, |d| ) is a stroke of CONSTANT value
   * across CONSTANT width with one antialiased step at each side. At a 28 m
   * camera that is a 3-4 px hard-shouldered line, and no amount of noise on top
   * of it changes the read, because the read comes from the profile.
   *
   * So the outline is a SUM of three lobes measured off the same SDF, each with
   * its own width and its own falloff exponent:
   *
   *   core    thin, crisp, the gameplay-legible line          (0.34 x rimW)
   *   spill   wide, quadratic, light bleeding into the stone   (3.1 x rimW)
   *   inward  one-sided, cubic-ish, light washing back over
   *           the threatened ground                            (5.4 x rimW)
   *
   * Every width is floored against fwidth() so no lobe can fall below a pixel and
   * flicker, and the whole sum is renormalised so the PEAK stays where the
   * exposure budget put it — the extra width buys a soft edge, never brightness.
   * Because the core is narrow and bright while the spill is wide and dim, the
   * stroke has a genuine value gradient from its centre outward: an inner edge,
   * a shoulder, and an outer edge that reaches zero.
   */
  float aD = abs( dW );
  float wCore  = max( rimW * 0.34, aa * 1.15 );
  float wSpill = max( rimW * 3.10, aa * 4.20 );
  float wIn    = max( rimW * 5.40, aa * 6.50 );
  /* Core: the plateau is kept for closed shapes (a hairline needs a flat top to
     survive resampling) and dropped for lanes, which are wide enough to carry a
     gradient all the way through. */
  float core = 1.0 - smoothstep( wCore * ( 0.20 + 0.55 * rimPlateau ), wCore, aD );
  float spill = 1.0 - min( aD / wSpill, 1.0 );
  spill *= spill * ( 1.30 - 0.30 * spill );          // quadratic, softened knee
  float inward = clamp( 1.0 + dW / wIn, 0.0, 1.0 );
  inward = inward * inward * inward * step( dW, 0.0 );
  /* 0.61 renormalises the 1.0 + 0.42 + 0.34 sum back to a ~1.07 peak, which is
     the level RING_LUM and L_RIM were measured against. */
  float rim = ( core + spill * 0.42 + inward * 0.34 ) * 0.61 * lane;
  rim *= ( 0.30 + 0.70 * wear ) * ( 0.44 + 0.64 * flow );
  /* One near-black groove immediately inside the rim, and nothing else. The rim
     then reads as an engraved edge through light/dark contrast instead of raw
     brightness — which is what lets the whole thing sit under the bloom
     threshold. A third concentric scribe line was pure noise: on a 0.9 m lane
     three lines land inside six pixels and blur into a fuzzy double stroke. */
  float groove = ( 1.0 - smoothstep( rimW * 0.6, rimW * 1.8, abs( d + rimW * 2.1 ) ) )
    * inside * grooveOn;

  /* Body coverage. For closed shapes this is just the antialiased interior; for
     a lane it is the interior weighted by the spine gaussian and the outward
     dissipation, which is what removes every hard silhouette edge. */
  float body = inside * spine * lane;

  /* --- sweeping fill front --- */
  float swept = 1.0 - smoothstep( prog, prog + 0.03, fillT );
  float front = exp( -pow( ( fillT - prog ) / 0.05, 2.0 ) )
    * step( 0.015, prog ) * ( 1.0 - step( 0.995, prog ) ) * inside * spine
    * ( 0.52 + 0.62 * flow );

  /* Radial ramp for closed shapes: the interior tint falls away toward the
     boundary instead of ending as a flat plate against a hard rim. Together with
     the erosion this is what makes the fill read as a cast of light over the
     flagstones rather than as a painted disc. */
  float radRamp = mix( 1.0,
    0.30 + 0.70 * ( 1.0 - smoothstep( 0.50, 1.0, fillT ) ), step( kind, 2.5 ) );
  radRamp *= 0.52 + 0.60 * ero;

  /* --- drifting hazard streaks inside the swept area --- */
  float hatch = 0.5 + 0.5 * sin( ( p.x * 0.72 + p.y * 0.72 ) * 5.0 - uTime * 2.1 + seed * 6.28 );
  hatch = smoothstep( 0.55, 0.98, hatch ) * body * swept;

  /* --- release: a hot flash that runs across the shape, then gone --- */
  float since = uTime - endT;
  float flash = released > 0.5
    ? smoothstep( 0.0, 0.04, since ) * ( 1.0 - smoothstep( 0.06, 0.34, since ) )
    : 0.0;
  float fadeOut = 1.0 - smoothstep( 0.0, released > 0.5 ? 0.34 : 0.16, since );
  float fadeIn = smoothstep( 0.0, 0.11, t );
  if ( fadeOut <= 0.0 ) discard;

  /* danger only ever scales COVERAGE, never brightness — a heavy attack reads
     as a denser, more insistent field, not as a hotter one. */
  float danger = vT3.w;
  float impend = 0.58 + 0.42 * prog * prog;
  float pulse = 0.88 + 0.12 * sin( uTime * ( 5.0 + 9.0 * prog ) + seed * 6.28 );
  /* Deepen the chroma instead of raising the value. The incoming tint is
     normalised to a peak of 1.0, so the only headroom left for "this reads as
     hellfire, not as a highlight" is saturation — and saturation is free against
     the bloom threshold, which is measured on luminance. */
  vec3 tint = pow( max( vT3.rgb, vec3( 0.0 ) ), vec3( 1.35 ) );
  /* Barely any white in the rim. Desaturating toward white is precisely what
     made the old read resolve as a blown cream highlight rather than hot iron. */
  vec3 hot = mix( tint, vec3( 1.0 ), 0.045 );
  /* Normalise the light colour to UNIT LUMINANCE, so the L_* gains below are
     display luminances rather than "some number times whatever hue happened to
     be passed in". Two reasons this matters:
       • a saturated orange has ~0.59 the luminance of a pale cyan at the same
         channel level, so a single gain made one read three stops hotter,
       • and it lets the final ceiling be a SAFETY RAIL instead of a limiter. A
         hard limiter flattens every pixel that exceeds it onto one value, which
         wiped out the erosion and flow modulation entirely and put the clean
         constant-brightness stroke straight back. */
  float hotL = max( dot( hot, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
  vec3 hotN = hot / hotL;

  /* --- composite: SHADOW layers and LIGHT layers are not the same operation ---
   *
   * A telegraph does two different things to the floor. The contact shade, the
   * interior tint and the engraved groove are SHADOW: they must multiply the
   * stone down, so their coverage IS their occlusion. The rim, the sweep front
   * and the release flash are LIGHT: they must add on top and leave the stone's
   * grain and joints readable straight through them.
   *
   * Premultiplied blending resolves as dst * ( 1 - A ) + C. So holding A low
   * while keeping C is exactly additive, and raising A is exactly paint. Each
   * light layer therefore declares how little of the floor it is allowed to hide
   * (~0.25 of its coverage). That single split is the difference between a ring
   * that reads as light lying ON stone and the white paint stroke this replaces:
   * before, a 0.94-coverage rim erased the flagstone under it completely.
   */
  vec3 c = vec3( 0.0 );
  float A = 0.0;
  float lightShare = 0.0;
  #define SHDW(LC,LA) { float la = clamp( LA, 0.0, 1.0 ); \
    c = ( LC ) * la + c * ( 1.0 - la ); A = la + A * ( 1.0 - la ); }
  #define LGHT(LC,LA,OCC) { float la = clamp( LA, 0.0, 1.0 ); float oa = la * ( OCC ); \
    c += ( LC ) * la; A = oa + A * ( 1.0 - oa ); lightShare = max( lightShare, la ); }

  /* Outer contact shade. bleedIn keeps it off the interior of a lane — an
     unconditional 0.15-alpha near-black over a 21 m x 3.4 m footprint is a dark
     rectangle sitting on the floor, which is exactly the shape that read as
     broken geometry over the boss arena's bright stone. */
  float bleedM = mix( 1.0 - inside, 1.0, bleedIn );
  SHDW( tint * BLEED,  exp( -max( 0.0, d ) / 0.34 ) * 0.26 * impend * bleedM )
  SHDW( tint * WASH,   body * ( 0.16 + 0.15 * swept ) * impend * danger * fillM * radRamp )
  SHDW( tint * STREAK, hatch * 0.14 * danger )
  SHDW( tint * SHADE,  groove * 0.62 )
  LGHT( hotN * L_FRONT * frontM, front * 0.66 * frontM, 0.30 )
  LGHT( hotN * L_RIM * ( 0.86 + 0.14 * prog ) * pulse * rimGain, rim * rimCov, 0.26 )
  LGHT( hotN * L_RIM * 1.20, flash * ( 0.30 + 0.60 * rim ) * mix( max( body, rim ), 1.0, bleedIn ), 0.32 )
  #undef SHDW
  #undef LGHT

  /* Premultiplied colour must be scaled by exactly the same factor as coverage.
     Fading the coverage alone would leave the colour at full strength and the
     shape would flare
     into a pure additive glow on the way in and on the way out.
     proj rides in here for the same reason: it is a coverage term (how much of
     this pixel's surface actually belongs to the decal plane), so it has to scale
     colour and alpha together or the silhouette edge would turn additive. */
  float k = fadeIn * fadeOut * master * proj;
  float a = clamp( A, 0.0, 1.0 ) * k;
  if ( a < 0.004 ) discard;

  /* SAFETY RAIL, then the exposure normalisation, so the cap keeps meaning "this
     many display units" rather than "this many scene units". The authored level
     comes from L_RIM/L_FRONT above; this only catches stacking (two telegraphs
     overlapping, a flash on top of a rim) and sits far enough above the authored
     peak that it does not act as a limiter — a limiter would flatten the erosion
     and flow modulation into the constant-brightness stroke it replaced.
     Scaling the colour as a whole is what preserves the hue: the old
     per-channel min() railed red first and let green climb behind it. */
  float cap = mix( AREA_LUM, RING_LUM, clamp( lightShare * 1.7, 0.0, 1.0 ) );
  float lum = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
  /* ...and a max-channel rail on top of it. A deeply saturated tint has a low
     luminance for a high red channel, so a luma-only cap still lets R clip, and
     a clipped channel is what drags the grade's highlight desaturation into
     turning the read cream. 1.9x the luma cap keeps the hue rich without it. */
  float mxc = max( c.r, max( c.g, c.b ) );
  c *= min( 1.0, min( cap / max( lum, 1e-4 ), cap * 1.9 / max( mxc, 1e-4 ) ) );

  gl_FragColor = vec4( c * k * uExpNorm, a );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class TelegraphField {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {import('./Surface.js').Surface} surface
   */
  constructor(engine, surface) {
    this.engine = engine;
    this.surface = surface;
    this.slots = SLOTS;
    this.active = 0;
    this._map = new Map();      // uid -> record
    this._free = [];
    for (let i = SLOTS - 1; i >= 0; i--) this._free.push(i);
    this._uid = 0;
    this._biome = 'crypt';

    const nv = SLOTS * VPS, ni = SLOTS * IPS;
    this.geo = new THREE.BufferGeometry();
    const mk = (n, item) => {
      const a = new THREE.BufferAttribute(new Float32Array(n * item), item);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.pos = mk(nv, 3);
    this.loc = mk(nv, 2);
    this.t1 = mk(nv, 4);
    this.t2 = mk(nv, 4);
    this.t3 = mk(nv, 4);
    this.t4 = mk(nv, 4);
    this.geo.setAttribute('position', this.pos);
    this.geo.setAttribute('aLocal', this.loc);
    this.geo.setAttribute('aT1', this.t1);
    this.geo.setAttribute('aT2', this.t2);
    this.geo.setAttribute('aT3', this.t3);
    this.geo.setAttribute('aT4', this.t4);

    const idx = new Uint32Array(ni);
    const n = RES + 1;
    for (let s = 0; s < SLOTS; s++) {
      const vb = s * VPS;
      let m = s * IPS;
      for (let j = 0; j < RES; j++) {
        for (let i = 0; i < RES; i++) {
          const a = vb + j * n + i, b = a + 1, c = a + n, dd = c + 1;
          idx[m++] = a; idx[m++] = c; idx[m++] = b;
          idx[m++] = b; idx[m++] = c; idx[m++] = dd;
        }
      }
    }
    this.idx = new THREE.BufferAttribute(idx, 1);
    this.geo.setIndex(this.idx);
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.uTime = { value: 0 };
    this.uExpNorm = { value: 1 };
    this.uDepth = { value: null };
    this.uClipToWorld = { value: new THREE.Matrix4() };
    this.uDepthOn = { value: 0 };
    this.uThick = { value: PROJ_THICK };
    this._clipToWorld = new THREE.Matrix4();
    this._depthWarned = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.uTime,
        uExpNorm: this.uExpNorm,
        uDepth: this.uDepth,
        uClipToWorld: this.uClipToWorld,
        uDepthOn: this.uDepthOn,
        uThick: this.uThick,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      /* A HAIRLINE, not the old -5/-10.
         That bias existed to force the field through the depth test against the
         floor's relief, and it did so by also forcing it through boots, barrels,
         rubble and wall bases — which is precisely the "drawn above the scene"
         read. Conformance is now the depth-projection test's job (see
         `projectionWeight`), so all polygonOffset has left to do is keep the
         patch off the coplanar z-fighting knife edge, which the 0.032 m of world
         lift almost does on its own. */
      polygonOffsetFactor: -1.0,
      polygonOffsetUnits: -2.0,
      polygonOffset: true,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      toneMapped: true,
    });
    this.material.name = 'NonaTelegraph';
    /* One fragment texture unit, and only on this program. The stain atlas spends
       two on its own program; nothing here is shared with a lit material, so the
       16-unit ceiling is nowhere near it. */
    this.material.userData.noCSM = true;
    this.material.userData.noGBuffer = true;

    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.name = 'decals:telegraphs';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 7;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.userData.noDecal = true;
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld();

    this._col = new THREE.Color();
    this._lo = Infinity;
    this._hi = -Infinity;
    this._occ = new Uint8Array(SLOTS);
    this._top = -1;
    this.geo.setDrawRange(0, 0);
    for (let i = 0; i < SLOTS; i++) this._blank(i);
    this.flush();
  }

  setBiome(b) { this._biome = b ?? 'crypt'; }

  _dirty(s) {
    if (s < this._lo) this._lo = s;
    if (s > this._hi) this._hi = s;
  }

  _blank(slot) {
    const vb = slot * VPS;
    const pa = this.pos.array, t4 = this.t4.array;
    for (let i = 0; i < VPS; i++) {
      const o3 = (vb + i) * 3;
      pa[o3] = 0; pa[o3 + 1] = -9999; pa[o3 + 2] = 0;
      t4[(vb + i) * 4 + 3] = 0;
    }
    this._occ[slot] = 0;
    this._dirty(slot);
  }

  /** Never submit index blocks past the highest live slot. */
  _retop() {
    let top = -1;
    for (let i = SLOTS - 1; i >= 0; i--) if (this._occ[i]) { top = i; break; }
    if (top === this._top) return;
    this._top = top;
    this.geo.setDrawRange(0, (top + 1) * IPS);
  }

  /* ------------------------------------------------------------- geometry */

  /** Local-space bounds of a shape, in (along, across) metres. */
  _bounds(rec) {
    const R = rec.radius, LEN = rec.length, W = rec.width, HA = rec.halfAngle;
    switch (rec.kind) {
      case KIND.circle:
      case KIND.ring:
        return { ox: 0, oz: 0, hl: R + PAD, hw: R + PAD };
      case KIND.cone: {
        if (HA >= Math.PI * 0.5) return { ox: 0, oz: 0, hl: LEN + PAD, hw: LEN + PAD };
        const hw = LEN * Math.sin(HA) + PAD;
        return { ox: LEN * 0.5, oz: 0, hl: LEN * 0.5 + PAD, hw };
      }
      default:
        // W is the lane's full width; the patch needs half of it plus the skirt.
        return { ox: LEN * 0.5, oz: 0, hl: LEN * 0.5 + PAD, hw: W * 0.5 + PAD };
    }
  }

  /** Write the conforming patch for a record's current pose. */
  _writeGeometry(rec) {
    const b = this._bounds(rec);
    const ca = Math.cos(rec.yaw), sa = Math.sin(rec.yaw);
    const S = this.surface;
    const vb = rec.slot * VPS;
    const pa = this.pos.array, la = this.loc.array;
    const n = RES + 1;
    const step = Math.max(0.1, Math.min(b.hl, b.hw) / RES);
    const gy0 = S ? S.groundY(rec.x, rec.z) : 0;
    const shift = (rec.baseY ?? gy0) - gy0;

    let k = 0;
    for (let j = 0; j < n; j++) {
      const fv = j / RES;
      const lz = b.oz + (fv - 0.5) * 2 * b.hw;
      for (let i = 0; i < n; i++, k++) {
        const fu = i / RES;
        const lx = b.ox + (fu - 0.5) * 2 * b.hl;
        const wx = rec.x + lx * ca - lz * sa;
        const wz = rec.z + lx * sa + lz * ca;
        let y = gy0, ny = 1;
        if (S) {
          const hC = S.groundY(wx, wz);
          const gx = (S.groundY(wx - step, wz) - S.groundY(wx + step, wz)) / (2 * step);
          const gz = (S.groundY(wx, wz - step) - S.groundY(wx, wz + step)) / (2 * step);
          ny = 1 / Math.sqrt(gx * gx + gz * gz + 1);
          y = hC;
        }
        const o3 = (vb + k) * 3, o2 = (vb + k) * 2;
        pa[o3] = wx; pa[o3 + 1] = y + shift + ny * LIFT; pa[o3 + 2] = wz;
        la[o2] = lx; la[o2 + 1] = lz;
      }
    }
    this._dirty(rec.slot);
  }

  _writeParams(rec) {
    const vb = rec.slot * VPS;
    const t1 = this.t1.array, t2 = this.t2.array, t3 = this.t3.array, t4 = this.t4.array;
    const a = rec.kind, b = rec.radius, c = rec.inner, d = rec.length;
    const e = rec.width, f = rec.halfAngle, g = rec.t0, h = rec.duration;
    const cr = rec.cr, cg = rec.cg, cb = rec.cb, dg = rec.danger;
    const et = rec.endT, rl = rec.released, sd = rec.seed, ms = rec.master;
    for (let i = 0; i < VPS; i++) {
      const o = (vb + i) * 4;
      t1[o] = a; t1[o + 1] = b; t1[o + 2] = c; t1[o + 3] = d;
      t2[o] = e; t2[o + 1] = f; t2[o + 2] = g; t2[o + 3] = h;
      t3[o] = cr; t3[o + 1] = cg; t3[o + 2] = cb; t3[o + 3] = dg;
      t4[o] = et; t4[o + 1] = rl; t4[o + 2] = sd; t4[o + 3] = ms;
    }
    this._occ[rec.slot] = ms > 0 ? 1 : 0;
    this._dirty(rec.slot);
  }

  /* ---------------------------------------------------------------- API */

  /**
   * Start (or restart) a telegraph. Accepts the AI's telegraph object verbatim,
   * and also a loose spec from anything else on the bus.
   */
  begin(tg) {
    if (!tg) return null;
    const uid = tg.uid ?? tg.id ?? `t${++this._uid}`;
    if (this._map.has(uid)) { this.update(tg); return uid; }

    const shapeName = String(tg.shape ?? 'circle');
    const kind = KIND[shapeName] ?? KIND.circle;
    const elapsed = this.engine.clock.elapsed;

    let radius = +(tg.radius ?? 0) || 0;
    let length = +(tg.length ?? tg.range ?? 0) || 0;
    let width = +(tg.width ?? 0) || 0;
    let inner = +(tg.inner ?? 0) || 0;
    const angle = +(tg.angle ?? 0) || 0;
    if (kind === KIND.circle && radius <= 0.05) radius = Math.max(1.2, length * 0.5);
    if (kind === KIND.ring && radius <= 0.05) radius = Math.max(2, length * 0.5);
    if (kind === KIND.cone && length <= 0.05) length = Math.max(2, radius);
    if (kind === KIND.line && length <= 0.05) length = Math.max(3, radius * 2);
    if (kind === KIND.line && width <= 0.02) width = 0.9;
    /* Ceilings are sanity rails, not art direction — the archetypes author real
       metres (a boss slam is 6.6 m, its quake 13.5 m). But a bad `radius` must
       not be able to spread a 50 m disc across the whole arena. */
    radius = Math.min(radius, 16);
    length = Math.min(length, 22);
    width = Math.min(width, 8);
    if (kind === KIND.line) {
      /* ASPECT RAIL. A lane needs enough width to be shaded as a field; below
         about a metre at a 28 m camera it is a few pixels across and the shader
         has nowhere to put a soft shoulder, so it degenerates into a pair of
         dead-straight hairlines. The archer's 17 m x 0.55 m bolt path did
         exactly that and drew a 540 px white line across the night moor. Floor
         the width against the length; the read over-reports the flight path by
         ~0.25 m per side, which is the correct trade for a shape that must be
         legible in a fraction of a second. */
      width = Math.max(width, Math.min(1.30, 0.86 + length * 0.014));
    }
    inner = Math.min(inner, radius * 0.94);

    const total = Math.max(1, Math.min(3, tg.salvo ?? 1));
    const spread = tg.salvoSpread ?? 0;
    const rec0 = [];
    for (let s = 0; s < total; s++) {
      if (!this._free.length) break;
      const slot = this._free.pop();
      const a = total > 1 ? (s / total) * TAU + 0.4 : 0;
      const off = total > 1 ? spread * 0.5 : 0;
      const rec = {
        slot, kind, radius, inner, length, width,
        halfAngle: Math.max(0.06, (angle > 0 ? angle : 1.4) * 0.5),
        t0: Number.isFinite(tg.t0) ? tg.t0 : elapsed,
        duration: Math.max(0.14, +(tg.duration ?? tg.windup ?? 0.8)),
        x: (tg.x ?? 0) + Math.cos(a) * off,
        z: (tg.z ?? 0) + Math.sin(a) * off,
        yaw: tg.yaw ?? 0,
        baseY: undefined,
        cr: 1, cg: 0.42, cb: 0.14,
        danger: DANGER[String(tg.danger ?? 'medium')] ?? 1.0,
        endT: 1e9, released: 0, master: 1,
        seed: ((hash(String(uid)) + s * 7919) % 1024) / 1024,
      };
      /* --- hue -----------------------------------------------------------
         A telegraph carries information in its colour, so the hue is resolved in
         priority order and there is always an answer:
           an explicit colour,          e.g. an ability's own accent
           the element about to land,   fire / frost / arcane / necrotic / ...
           the caster's rarity,         white / blue / yellow / orange / red
           the danger class,            amber -> orange -> hot red
         Never a rainbow: each family is ONE saturated accent, and the shader
         normalises whatever arrives to unit luminance, so changing hue changes
         the colour of the read and never its brightness or its bloom headroom. */
      const hex = resolveHue(tg);
      if (Number.isFinite(hex)) {
        this._col.setHex(hex >>> 0, THREE.SRGBColorSpace);
        // ground indicators need to stay legible against wet stone, so the tint
        // is normalised to a known brightness rather than trusted raw
        const mx = Math.max(this._col.r, this._col.g, this._col.b, 1e-3);
        rec.cr = this._col.r / mx; rec.cg = this._col.g / mx; rec.cb = this._col.b / mx;
      }
      if (this.surface) {
        const pr = this.surface.probe(rec.x, rec.z);
        rec.baseY = pr.ok ? pr.y : undefined;
      }
      this._writeGeometry(rec);
      this._writeParams(rec);
      rec0.push(rec);
    }
    if (!rec0.length) return null;
    this._map.set(uid, rec0);
    this.active = this._map.size;
    return uid;
  }

  /** Re-aim during the trackable part of the windup. */
  update(tg) {
    if (!tg) return;
    const uid = tg.uid ?? tg.id;
    const recs = uid !== undefined ? this._map.get(uid) : null;
    if (!recs) return;
    const nx = tg.x ?? 0, nz = tg.z ?? 0, ny = tg.yaw ?? 0;
    for (const rec of recs) {
      if (rec.master <= 0) continue;
      const moved = Math.abs(nx - rec.x) + Math.abs(nz - rec.z) > 0.09
        || Math.abs(wrapPi(ny - rec.yaw)) > 0.02;
      if (!moved) continue;
      rec.x = nx; rec.z = nz; rec.yaw = ny;
      if (this.surface) {
        const pr = this.surface.probe(rec.x, rec.z);
        rec.baseY = pr.ok ? pr.y : undefined;
      }
      this._writeGeometry(rec);
    }
  }

  /** Windup finished — flash and release, or fade if it was interrupted. */
  end(tg) {
    if (!tg) return;
    const uid = tg.uid ?? tg.id;
    const recs = uid !== undefined ? this._map.get(uid) : null;
    if (!recs) return;
    const now = this.engine.clock.elapsed;
    for (const rec of recs) {
      rec.endT = now;
      rec.released = tg.cancelled ? 0 : 1;
      rec.dieAt = now + (tg.cancelled ? 0.18 : 0.36);
      this._writeParams(rec);
    }
    this._map.delete(uid);
    this._dying = this._dying ?? [];
    for (const rec of recs) this._dying.push(rec);
    this.active = this._map.size;
  }

  /**
   * Bind this frame's solid-depth buffer and the matrix that unprojects it.
   *
   * Both have to be refreshed every frame and in this order relative to the
   * beauty pass: the G-buffer prepass runs immediately before the composer with
   * the SAME camera matrices, and `Decals.update` runs before RenderPipeline in
   * the module manifest, so the matrix written here is the one the prepass and
   * the beauty pass both use. Reading it on a scenario hook instead would leave
   * it a frame stale and put a one-pixel rejection halo on every silhouette.
   *
   * Everything is optional and guarded: no pipeline, no G-buffer (tier `low`), or
   * a frame where nothing asked for the prepass all fall back to `uDepthOn = 0`,
   * which makes `projectionWeight()` return 1 and the field behave as it did
   * before. A missing depth buffer must never make a gameplay-critical read
   * disappear.
   */
  _bindDepth() {
    const cam = this.engine?.camera;
    let tex = null;
    try {
      const rp = this.engine?.renderPipeline ?? this.engine?.get?.('render');
      if (rp && !rp.__dead && rp.gbuffer) {
        // The prepass only runs when one of its consumers wants it; a stale or
        // cleared buffer would reject every fragment in the field.
        const live = typeof rp._needsGBuffer === 'function' ? rp._needsGBuffer() !== false : true;
        if (live) tex = rp.gbuffer.depthTexture ?? null;
      }
    } catch (e) {
      if (!this._depthWarned) {
        this._depthWarned = true;
        console.warn('[decals] telegraph depth projection unavailable —', e?.message ?? e);
      }
      tex = null;
    }
    if (!tex || !cam) {
      this.uDepth.value = null;
      this.uDepthOn.value = 0;
      return;
    }
    /* NDC -> world in one matrix: inverse projection, then camera world. Three
       keeps both up to date on the camera, so this is two multiplies a frame. */
    cam.updateMatrixWorld();
    this._clipToWorld.multiplyMatrices(cam.matrixWorld, cam.projectionMatrixInverse);
    this.uClipToWorld.value.copy(this._clipToWorld);
    this.uDepth.value = tex;
    this.uDepthOn.value = 1;
  }

  /** Retire faded slots and push the clock. */
  tick(elapsed) {
    this.uTime.value = elapsed;
    /* Refreshed per frame, not on a scenario hook: RenderPipeline is the last
       manifest module, so this value does not exist yet when scenarios apply. */
    const norm = this.engine?.vfxExposureNorm;
    this.uExpNorm.value = Number.isFinite(norm) ? Math.min(1, Math.max(0.25, norm)) : 1;
    this._bindDepth();
    const dying = this._dying;
    if (dying && dying.length) {
      for (let i = dying.length - 1; i >= 0; i--) {
        const rec = dying[i];
        if (elapsed < rec.dieAt) continue;
        rec.master = 0;
        this._blank(rec.slot);
        this._free.push(rec.slot);
        dying.splice(i, 1);
      }
    }
    // A telegraph whose owner died without emitting 'end' must not linger.
    for (const [uid, recs] of this._map) {
      const r0 = recs[0];
      if (!r0) { this._map.delete(uid); continue; }
      if (elapsed - r0.t0 > r0.duration + 6) {
        this.end({ uid, cancelled: true });
      }
    }
    this.flush();
  }

  clear() {
    for (const [, recs] of this._map) {
      for (const rec of recs) { this._blank(rec.slot); this._free.push(rec.slot); }
    }
    this._map.clear();
    if (this._dying) {
      for (const rec of this._dying) { this._blank(rec.slot); this._free.push(rec.slot); }
      this._dying.length = 0;
    }
    this.active = 0;
    this.flush();
  }

  flush() {
    if (this._hi < this._lo) return;
    this._retop();
    const lo = this._lo, hi = this._hi, n = hi - lo + 1;
    const vs = lo * VPS, vc = n * VPS;
    this.pos.addUpdateRange(vs * 3, vc * 3); this.pos.needsUpdate = true;
    this.loc.addUpdateRange(vs * 2, vc * 2); this.loc.needsUpdate = true;
    for (const a of [this.t1, this.t2, this.t3, this.t4]) {
      a.addUpdateRange(vs * 4, vc * 4);
      a.needsUpdate = true;
    }
    this._lo = Infinity;
    this._hi = -Infinity;
  }

  dispose() {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
    this._map.clear();
  }
}

function wrapPi(a) {
  let v = a;
  while (v > Math.PI) v -= TAU;
  while (v < -Math.PI) v += TAU;
  return v;
}

/**
 * Resolve a telegraph's accent hue. Explicit colour wins, then the element, then
 * the rarity of whatever is casting it, then the danger class — so a caller that
 * says nothing at all still gets a deliberate warm accent rather than white.
 * @param {Record<string, any>} tg
 * @returns {number} 24-bit sRGB hex
 */
function resolveHue(tg) {
  const raw = tg.color ?? tg.tint ?? tg.hue;
  if (Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw[0] === '#') {
    const v = Number.parseInt(raw.slice(1), 16);
    if (Number.isFinite(v)) return v;
  }
  const el = tg.element ?? tg.damageType ?? tg.type ?? tg.school;
  if (el !== undefined) {
    const h = ELEMENT_HUE[String(el).toLowerCase()];
    if (h !== undefined) return h;
  }
  const rar = tg.rarity ?? tg.tier ?? tg.quality;
  if (rar !== undefined) {
    const h = RARITY_HUE[String(rar).toLowerCase()];
    if (h !== undefined) return h;
  }
  return DANGER_HUE[String(tg.danger ?? 'medium')] ?? DANGER_HUE.medium;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
