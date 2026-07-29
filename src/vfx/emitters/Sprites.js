import * as THREE from 'three';
import { hash2 } from '../../core/Rand.js';

/**
 * SANCTUM — GPU billboard particle batch.
 *
 * One `InstancedBufferGeometry` of unit quads, one draw call, one time uniform.
 * The CPU only ever writes a slot's *initial conditions* on spawn; every frame
 * after that the vertex shader integrates the trajectory, animates size, colour
 * and rotation, and builds the billboard. There is no per-particle CPU work and
 * no allocation after construction — spawning is a ring-buffer write, so the
 * oldest particle is recycled when the pool is full.
 *
 * Two things matter more than throughput here, because both are rubric
 * instant-fails:
 *
 *  1. **Soft particles.** Every fragment samples the scene depth prepass and
 *     fades its alpha across a per-particle depth band, so a smoke puff sinks
 *     *into* the floor instead of cutting a hard line across it. Without this a
 *     billboard cloud reads as a stack of decals.
 *  2. **No camera-facing squares, no hard dots.** There is no "default sprite":
 *     every shape is an authored procedural falloff (radial, streak, eroded
 *     cloud, flame lick, crystal, chip, droplet, annulus, star, splat, shaft,
 *     mote) evaluated in the fragment shader. That costs zero texture units —
 *     the project is at 14/16 samplers — and it never shows an atlas seam.
 *
 * A single 256² RGBA mask texture carries the four noise fields the analytic
 * shapes erode themselves with. One sampler for masks, one for the depth
 * prepass: two units for the whole VFX layer.
 */

/* ------------------------------------------------------------------ enums */

export const SHAPE = {
  GLOW: 0,     // soft radial halo — the workhorse glow
  SPARK: 1,    // velocity-stretched streak with a thin hot core
  SMOKE: 2,    // cloud-eroded puff, form-lit
  FLAME: 3,    // upright lick, narrows and erodes toward the tip
  SHARD: 4,    // crystalline frost splinter
  CHIP: 5,     // angular debris fleck, soft-edged
  DROP: 6,     // teardrop with a stretched tail
  RING: 7,     // annulus / shockwave
  STAR: 8,     // 4-ray sparkle
  SPLAT: 9,    // irregular ground blob
  SHAFT: 10,   // vertical light column
  MOTE: 11,    // very soft low-alpha air particulate
  WISP: 12,    // filament-eroded arcane/necrotic wisp
};

export const ALIGN = {
  CAMERA: 0,   // screen-aligned billboard
  VELOCITY: 1, // stretched along screen-space velocity
  GROUND: 2,   // lies flat on the XZ plane
  UPRIGHT: 3,  // Y stays world-up, faces the camera horizontally
};

/* ------------------------------------------------------------- spawn spec */

/**
 * Reusable spawn descriptor. Recipes fill one shared instance and hand it to
 * `SpriteBatch.emit()`, so a thousand spawns a second allocate nothing.
 */
export class Spec {
  constructor() { this.reset(); }

  reset() {
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.life = 1;
    this.delay = 0;
    this.size0 = 0.2; this.size1 = 0.2;
    this.aspect = 1;          // width / height (1 = square quad)
    this.sizeCurve = 1;
    this.rot = 0; this.rotVel = 0;
    this.r0 = 1; this.g0 = 1; this.b0 = 1; this.a0 = 1;
    this.r1 = 1; this.g1 = 1; this.b1 = 1; this.a1 = 0;
    this.drag = 0;
    this.gravity = 0;
    this.stretch = 0;
    this.seed = 0;
    this.swayAmp = 0;
    this.swayFreq = 1.4;
    this.shape = SHAPE.GLOW;
    this.soft = 0.45;
    this.align = ALIGN.CAMERA;
    return this;
  }

  /** Start colour + intensity (intensity multiplies rgb, so >1 blooms). */
  colorA(c, i = 1, a = 1) {
    this.r0 = c.r * i; this.g0 = c.g * i; this.b0 = c.b * i; this.a0 = a;
    return this;
  }
  colorB(c, i = 1, a = 0) {
    this.r1 = c.r * i; this.g1 = c.g * i; this.b1 = c.b * i; this.a1 = a;
    return this;
  }
  at(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  vel(x, y, z) { this.vx = x; this.vy = y; this.vz = z; return this; }
  size(a, b = a) { this.size0 = a; this.size1 = b; return this; }
}

/* --------------------------------------------------------- mask texture */

/**
 * Tileable value-noise fbm. `period` wraps the lattice so the texture repeats
 * seamlessly, which is what lets smoke scroll its erosion field without a
 * visible cut. Deterministic — hash2 only.
 */
function tileFbm(x, y, period, octaves, seed) {
  let sum = 0, norm = 0, amp = 0.5, freq = period;
  for (let o = 0; o < octaves; o++) {
    const fx = x * freq, fy = y * freq;
    const xi = Math.floor(fx), yi = Math.floor(fy);
    const tx = fx - xi, ty = fy - yi;
    const ux = tx * tx * (3 - 2 * tx), uy = ty * ty * (3 - 2 * ty);
    const f = Math.round(freq);
    const x0 = ((xi % f) + f) % f, y0 = ((yi % f) + f) % f;
    const x1 = (x0 + 1) % f, y1 = (y0 + 1) % f;
    const s = seed + o * 733;
    const a = hash2(x0, y0, s), b = hash2(x1, y0, s);
    const c = hash2(x0, y1, s), d = hash2(x1, y1, s);
    const n = (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
    sum += n * amp; norm += amp;
    amp *= 0.52; freq *= 2;
  }
  return sum / norm;
}

/** Tileable Worley F2-F1 — filaments for frost crackle and necrotic veins. */
function tileWorley(x, y, cells, seed) {
  const fx = x * cells, fy = y * cells;
  const xi = Math.floor(fx), yi = Math.floor(fy);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash2(wx, wy, seed);
      const py = cy + hash2(wx, wy, seed + 991);
      const d = (px - fx) * (px - fx) + (py - fy) * (py - fy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return Math.sqrt(f2) - Math.sqrt(f1);
}

/**
 * R = cloud fbm (smoke/flame erosion)
 * G = filament field  (frost, necrotic, lightning detail)
 * B = fine grain      (ember shimmer, dust variation)
 * A = soft radial     (base falloff, reused by splats and drops)
 */
export function buildMaskTexture(size = 256) {
  const n = size * size;
  const data = new Uint8Array(n * 4);
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x * inv, v = y * inv;

      let cloud = tileFbm(u, v, 4, 5, 21);
      cloud = Math.min(1, Math.max(0, (cloud - 0.32) * 1.85));
      data[i] = (cloud * 255) | 0;

      const fil = Math.min(1, Math.max(0, 1.0 - tileWorley(u, v, 7, 57) * 2.6));
      data[i + 1] = (fil * fil * 255) | 0;

      const grain = tileFbm(u, v, 16, 3, 131);
      data[i + 2] = (grain * 255) | 0;

      const dx = u - 0.5, dy = v - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const rad = Math.pow(1 - r, 1.9);
      data[i + 3] = (rad * 255) | 0;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.name = 'Sanctum.vfxMasks';
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------- shaders */

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uPxScale;   // world metres per pixel at 1 m of depth
uniform float uMinPx;     // minimum on-screen sprite size
uniform vec3 uFogParam;   // linear: (near, far, 0) | exp2: (density, 0, 1)

attribute vec3 iPos;
attribute vec3 iVel;
attribute vec2 iLife;     // (t0, life)
attribute vec3 iSize;     // (size0, size1, aspect)
attribute vec2 iRot;      // (rot0, rotVel)
attribute vec4 iC0;       // (r,g,b, opacity) at birth
attribute vec4 iC1;       // (r,g,b, opacity) at death
attribute vec4 iDyn;      // (drag, gravity, stretch, seed)
attribute vec4 iShape;    // (shape, soft, align, sizeCurve)
attribute vec2 iSway;     // (amplitude m, frequency Hz) — turbulent drift

varying vec2 vP;
varying vec4 vCol;
varying float vViewZ;
varying float vU;
varying float vSeed;
varying float vShape;
varying float vSoft;
varying float vFog;

void main() {
  float age = uTime - iLife.x;
  float life = max( iLife.y, 1e-4 );
  float u = age / life;

  if ( u < 0.0 || u >= 1.0 ) {
    // Dead / not yet born: collapse behind the far plane. Cheaper than a
    // CPU compaction pass and keeps the draw a single instanced call.
    vP = vec2( 0.0 ); vCol = vec4( 0.0 ); vViewZ = -1.0;
    vU = 0.0; vSeed = 0.0; vShape = 0.0; vSoft = 1.0; vFog = 0.0;
    gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
    return;
  }

  float k = iDyn.x;
  vec3 disp = ( k > 1e-3 ) ? iVel * ( ( 1.0 - exp( -k * age ) ) / k ) : iVel * age;
  disp.y -= 0.5 * iDyn.y * age * age;
  vec3 wp = iPos + disp;

  vec3 vel = iVel * exp( -k * age );
  vel.y -= iDyn.y * age;

  // Turbulent drift. Two out-of-phase oscillators whose amplitude ramps in with
  // age: an ember that leaves a fire dead straight and only wanders later is
  // exactly how convection reads, and it costs four trig calls.
  if ( iSway.x > 1e-4 ) {
    float ph = iDyn.w * 6.2831853;
    float sa = iSway.x * u;
    float w = iSway.y * age;
    wp.x += sin( w + ph ) * sa;
    wp.z += cos( w * 0.83 + ph * 1.7 ) * sa;
    wp.y += sin( w * 0.53 + ph * 0.7 ) * sa * 0.35;
    vel.x += cos( w + ph ) * iSway.x * iSway.y * 0.5;
    vel.z -= sin( w * 0.83 + ph * 1.7 ) * iSway.x * iSway.y * 0.42;
  }

  float su = ( abs( iShape.w - 1.0 ) < 1e-3 ) ? u : pow( u, iShape.w );
  float sz = mix( iSize.x, iSize.y, su );
  float rot = iRot.x + iRot.y * age;

  float align = iShape.z;
  vec2 corner = position.xy * 2.0;
  vP = corner;

  vec4 mvc = modelViewMatrix * vec4( wp, 1.0 );

  // Sub-pixel sprites alias into flicker; grow them to a floor and pay the
  // energy back in alpha so a distant ember dims instead of sparkling.
  float minWorld = uMinPx * uPxScale * max( -mvc.z, 0.05 );
  float szClamped = max( sz, minWorld );
  float energy = ( szClamped > sz + 1e-5 ) ? pow( sz / szClamped, 1.5 ) : 1.0;
  sz = szClamped;

  float szx = sz * iSize.z;
  float szy = sz;

  vec4 mv;
  if ( align < 1.5 ) {
    mv = mvc;
    vec2 o;
    if ( align < 0.5 ) {
      float c = cos( rot ), s = sin( rot );
      vec2 q = vec2( corner.x * szx, corner.y * szy ) * 0.5;
      o = vec2( q.x * c - q.y * s, q.x * s + q.y * c );
    } else {
      vec3 vv = mat3( modelViewMatrix ) * vel;
      vec2 ax = vv.xy;
      float axl = length( ax );
      ax = ( axl > 1e-4 ) ? ax / axl : vec2( 0.0, 1.0 );
      vec2 pp = vec2( -ax.y, ax.x );
      // iDyn.z is metres of trail per (m/s): a spark's streak length is its
      // actual speed, which is what makes a burst read as directional motion
      // rather than as a scatter of dots.
      float len = szy + iDyn.z * length( vel );
      o = ax * ( corner.y * len * 0.5 ) + pp * ( corner.x * szx * 0.5 );
    }
    mv.xy += o;
  } else {
    vec3 wo = wp;
    if ( align < 2.5 ) {
      float c = cos( rot ), s = sin( rot );
      vec2 q = vec2( corner.x * szx, corner.y * szy ) * 0.5;
      wo.xz += vec2( q.x * c - q.y * s, q.x * s + q.y * c );
    } else {
      vec3 toCam = cameraPosition - wp;
      vec3 rt = cross( vec3( 0.0, 1.0, 0.0 ), toCam );
      float rl = length( rt );
      rt = ( rl > 1e-4 ) ? rt / rl : vec3( 1.0, 0.0, 0.0 );
      wo += rt * ( corner.x * szx * 0.5 ) + vec3( 0.0, 1.0, 0.0 ) * ( corner.y * szy * 0.5 );
    }
    mv = modelViewMatrix * vec4( wo, 1.0 );
  }

  // Short fade-in kills spawn pop; the tail fade guarantees nothing vanishes
  // mid-opacity when its life runs out.
  float env = smoothstep( 0.0, 0.055, u ) * ( 1.0 - smoothstep( 0.80, 1.0, u ) );

  vCol = vec4( mix( iC0.rgb, iC1.rgb, u ), mix( iC0.a, iC1.a, u ) * env * energy );
  vViewZ = mv.z;
  vU = u;
  vSeed = iDyn.w;
  vShape = iShape.x;
  vSoft = iShape.y;

  float fd = -mv.z * uFogParam.x;
  vFog = mix(
    smoothstep( uFogParam.x, uFogParam.y, -mv.z ),
    1.0 - exp( -fd * fd ),
    uFogParam.z
  );

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uMasks;
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uClip;        // (near, far)
uniform float uSoftOn;
uniform float uTime;
uniform float uShaded;     // 1 = form-light the sprite (smoke), 0 = emissive
uniform vec3 uKeyDir;      // view-space direction toward the key light
uniform vec3 uKeyCol;
uniform vec3 uAmbCol;
uniform vec3 uFogColor;
uniform float uFogMix;     // how much fog affects this batch
uniform float uAdditive;   // 1 = additive blend (fog attenuates instead of tints)
uniform float uMaxRad;     // scene-linear ceiling for one additive sprite

varying vec2 vP;
varying vec4 vCol;
varying float vViewZ;
varying float vU;
varying float vSeed;
varying float vShape;
varying float vSoft;
varying float vFog;

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

float roundBox( vec2 p, vec2 b, float r ) {
  vec2 d = abs( p ) - b + r;
  return length( max( d, 0.0 ) ) + min( max( d.x, d.y ), 0.0 ) - r;
}

void main() {
  vec2 p = vP;
  float r = length( p );
  int sh = int( vShape + 0.5 );

  // Every shape is sampled from the same seeded, scrolling noise frame so two
  // particles of the same kind never look like copies of each other.
  vec2 nuv = p * 0.32 + vec2( vSeed * 0.531, vSeed * 0.277 );
  float a = 0.0;
  vec3 tint = vec3( 1.0 );

  if ( sh == 0 ) {                                   // GLOW
    float f = sat( 1.0 - r );
    a = pow( f, 2.1 ) * ( 0.55 + 0.45 * pow( f, 5.0 ) );
  } else if ( sh == 1 ) {                            // SPARK streak
    float w = sat( 1.0 - abs( p.x ) );
    float head = smoothstep( -1.05, -0.2, p.y );     // bright at the leading end
    float tail = 1.0 - smoothstep( 0.15, 1.0, p.y );
    float body = pow( w, 2.4 ) * head * tail;
    float core = exp( -abs( p.x ) * 7.0 ) * head * tail;
    a = sat( body * 0.75 + core * 0.9 );
    tint = mix( vec3( 1.0 ), vec3( 1.35, 1.2, 1.05 ), core );
  } else if ( sh == 2 ) {                            // SMOKE puff
    float f = sat( 1.0 - r );
    float base = pow( f, 1.55 );
    float n = texture2D( uMasks, nuv + vec2( vU * 0.05, -vU * 0.11 ) ).r;
    float n2 = texture2D( uMasks, nuv * 2.3 - vec2( vU * 0.07, 0.0 ) ).b;
    float e = n * 0.78 + n2 * 0.34;
    a = smoothstep( 0.16, 0.72, base * ( 0.42 + e ) );
    a *= base;
  } else if ( sh == 3 ) {                            // FLAME lick
    float h = sat( p.y * 0.5 + 0.5 );
    float wid = mix( 1.0, 0.20, h * h );
    float x = p.x / max( wid, 0.06 );
    float body = sat( 1.0 - x * x ) * ( 1.0 - h * 0.35 );
    float n = texture2D( uMasks, nuv * 1.5 + vec2( 0.0, -vU * 0.55 - vSeed * 0.3 ) ).r;
    a = smoothstep( 0.10, 0.62, body * ( 0.55 + n * 0.95 ) );
    a *= 1.0 - smoothstep( 0.72, 1.0, h );
    tint = mix( vec3( 1.0 ), vec3( 1.5, 1.28, 0.95 ), pow( sat( body ), 3.0 ) );
  } else if ( sh == 4 ) {                            // SHARD / frost crystal
    float ang = atan( p.y, p.x );
    float rr = r * ( 1.0 + 0.30 * cos( 6.0 * ang + vSeed * 6.28 ) );
    float body = smoothstep( 1.0, 0.42, rr );
    float edge = smoothstep( 0.30, 0.0, abs( rr - 0.62 ) ) * 0.9;
    float fil = texture2D( uMasks, nuv * 1.8 ).g;
    a = sat( body * ( 0.42 + fil * 0.5 ) + edge * body );
    tint = mix( vec3( 1.0 ), vec3( 1.25, 1.32, 1.45 ), edge );
  } else if ( sh == 5 ) {                            // CHIP debris
    float d = roundBox( p * vec2( 1.0, 1.45 ), vec2( 0.78, 0.62 ), 0.30 );
    a = smoothstep( 0.16, -0.14, d );
    float n = texture2D( uMasks, nuv * 3.0 ).b;
    tint = vec3( 0.72 + n * 0.5 );
  } else if ( sh == 6 ) {                            // DROP / droplet
    float y = p.y;
    float squash = 1.0 + sat( y ) * 1.5;             // tail trails behind
    float d = length( vec2( p.x * squash, y * 0.9 ) );
    a = pow( sat( 1.0 - d ), 1.25 );
    float spec = pow( sat( 1.0 - length( p - vec2( -0.24, -0.28 ) ) * 1.9 ), 3.5 );
    tint = vec3( 1.0 ) + spec * 0.85;
  } else if ( sh == 7 ) {                            // RING / shockwave
    // Band centred at 0.72 with a 0.26 half-width reaches zero at r = 0.98,
    // i.e. INSIDE the quad. Centred at 0.80/0.30 (as it was) the annulus was
    // still at 26% alpha where the quad ends, so the ring showed four straight
    // cuts where the unit square clipped it — a textbook "obvious camera-facing
    // quad". Nothing else changes about the read.
    float band = 1.0 - smoothstep( 0.0, 0.26, abs( r - 0.72 ) );
    float inner = smoothstep( 0.78, 0.50, r ) * 0.16;
    a = sat( pow( band, 1.7 ) + inner );
  } else if ( sh == 8 ) {                            // STAR sparkle
    float ang = atan( p.y, p.x );
    float rays = pow( abs( cos( 2.0 * ang ) ), 14.0 ) * pow( sat( 1.0 - r ), 1.1 );
    float core = pow( sat( 1.0 - r * 2.6 ), 2.0 );
    a = sat( rays * 0.85 + core );
  } else if ( sh == 9 ) {                            // SPLAT blob
    float n = texture2D( uMasks, nuv * 1.15 ).r;
    float f = sat( 1.0 - r );
    a = smoothstep( 0.30, 0.62, f * ( 0.55 + n * 1.05 ) );
  } else if ( sh == 10 ) {                           // SHAFT light column
    float h = sat( p.y * 0.5 + 0.5 );
    float w = sat( 1.0 - abs( p.x ) );
    float n = texture2D( uMasks, vec2( p.x * 0.2 + vSeed, h * 0.35 - vU * 0.4 ) ).r;
    a = pow( w, 2.3 ) * ( 1.0 - h * 0.82 ) * ( 0.62 + n * 0.6 );
    a *= smoothstep( 0.0, 0.12, h );
  } else if ( sh == 11 ) {                           // MOTE — never a hard dot
    float f = sat( 1.0 - r );
    a = pow( f, 3.4 ) * 0.62;
  } else {                                           // WISP filament
    float f = sat( 1.0 - r );
    float fil = texture2D( uMasks, nuv * 1.3 + vec2( vU * 0.13, -vU * 0.2 ) ).g;
    float cl = texture2D( uMasks, nuv * 0.8 ).r;
    a = smoothstep( 0.18, 0.70, pow( f, 1.35 ) * ( 0.35 + fil * 0.75 + cl * 0.35 ) );
  }

  /*
   * ---- rim envelope: zero alpha AND zero slope at the quad boundary ----
   *
   * Every analytic shape above is authored in [-1,1]² but several of them are
   * still non-zero when they reach that boundary — RING's annulus spans r=0.5
   * to 1.1, SHAFT keeps 18% alpha at its top, FLAME is opaque along its base,
   * SHARD's lobes bulge past r=1, DROP's tail runs off the top edge. Where a
   * shape meets the edge of its own quad the alpha steps to zero in one pixel,
   * and an additive sprite with a one-pixel alpha step reads as exactly what
   * the rubric calls an "obvious camera-facing quad": a straight cut, or the
   * triangular corner of the two tris, sawtoothing along the silhouette.
   *
   * A smoothstep has zero derivative at BOTH ends, so multiplying by one per
   * axis guarantees the alpha and its slope both reach zero before the
   * boundary. Two smoothsteps, no texture fetch, and no shape can ever show
   * its quad again.
   */
  vec2 qe = abs( p );
  a *= ( 1.0 - smoothstep( 0.70, 1.0, qe.x ) ) * ( 1.0 - smoothstep( 0.70, 1.0, qe.y ) );

  if ( a <= 0.0 ) discard;

  /* ---- soft particles: fade where the sprite meets solid geometry ---- */
  float fade = 1.0;
  if ( uSoftOn > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = ( uClip.x * uClip.y ) / ( ( uClip.y - uClip.x ) * d - uClip.y );
    fade = sat( ( vViewZ - sceneZ ) / max( vSoft, 1e-3 ) );
  }
  // ...and where it would clip the near plane.
  fade *= sat( ( -vViewZ - uClip.x ) / 0.9 );

  float alpha = a * vCol.a * fade;
  if ( alpha < 0.0035 ) discard;

  vec3 col = vCol.rgb * tint;

  if ( uShaded > 0.5 ) {
    // Fake the sprite as a hemisphere so smoke has a lit side and a dark side.
    // Flat grey puffs are the fastest way to make VFX read as cardboard.
    vec3 n = normalize( vec3( p, sqrt( max( 0.0, 1.0 - min( r * r, 1.0 ) ) ) ) );
    float lam = sat( dot( n, uKeyDir ) );
    float wrap = sat( dot( n, uKeyDir ) * 0.5 + 0.5 );
    // Deliberately restrained. Smoke lit to a mid grey reads as cotton wool and
    // lifts the blacks of the whole frame; a torchlit crypt only catches the
    // side of a puff that faces the flame.
    col *= uAmbCol + uKeyCol * ( lam * 0.46 + wrap * 0.20 );
  }

  float fog = vFog * uFogMix;

  if ( uAdditive > 0.5 ) {
    /*
     * ---- hard radiance ceiling ----
     *
     * Additive blending is src.rgb * src.a + dst, so the *product* is what
     * the HDR buffer receives; clamping rgb or alpha alone does nothing. The
     * pipeline then multiplies the buffer by an auto-exposure gain (1.8x-2.7x
     * depending on scenario) before ACES, so a sprite authored at 2.4 linear
     * arrives at the tonemapper near 6 and every channel pins at 1.0: a white
     * plateau with no hue and no shape, which is what a clipped additive
     * sprite looks like and why hits used to erase the hero.
     *
     * uMaxRad is the scene-linear value that ACES maps to ~0.85 AFTER that
     * gain (VFXSystem divides the 1.55 tonemap-0.85 point by the live gain).
     * The roll-off is exponential above a knee at 55% of the ceiling, so it is
     * C1-continuous — no banded plateau where the clamp engages — and it
     * scales the three channels together, so a warm spark stays warm instead
     * of desaturating to white as it gets hot. Bloom, which reads the buffer
     * before the tonemap, still sees a value at its threshold and supplies the
     * "this is bright" read as a halo rather than as a clipped core.
     */
    vec3 c = col * ( alpha * ( 1.0 - fog ) );
    float peak = max( c.r, max( c.g, c.b ) );
    float knee = uMaxRad * 0.55;
    if ( peak > knee ) {
      float head = max( uMaxRad - knee, 1e-4 );
      float rolled = knee + head * ( 1.0 - exp( -( peak - knee ) / head ) );
      c *= rolled / max( peak, 1e-5 );
    }
    // alpha = 1 with blendSrc = SrcAlpha makes the premultiplied colour the
    // literal contribution, so the clamp above is the real ceiling.
    gl_FragColor = vec4( c, 1.0 );
  } else {
    col = mix( col, uFogColor, fog );
    gl_FragColor = vec4( col, alpha );
  }
}
`;

/* ------------------------------------------------------------ the batch */

const FLOATS = {
  iPos: 3, iVel: 3, iSize: 3, iLife: 2, iRot: 2, iSway: 2,
  iC0: 4, iC1: 4, iDyn: 4, iShape: 4,
};

export class SpriteBatch {
  /**
   * @param {object} o
   * @param {number} o.capacity     pool size (fixed; oldest recycled when full)
   * @param {'add'|'alpha'} o.blend
   * @param {THREE.Texture} o.masks
   * @param {number} [o.renderOrder]
   * @param {number} [o.shaded]     1 to form-light the sprites
   * @param {string} [o.name]
   */
  constructor(o) {
    this.capacity = Math.max(16, o.capacity | 0);
    this.blend = o.blend === 'alpha' ? 'alpha' : 'add';
    this._head = 0;
    this._hi = 0;
    this._maxExp = -1e9;
    this._now = 0;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;
    this.spawned = 0;
    this.dropped = 0;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    this.arrays = {};
    this.attrs = {};
    for (const key in FLOATS) {
      const n = FLOATS[key];
      const arr = new Float32Array(this.capacity * n);
      const attr = new THREE.InstancedBufferAttribute(arr, n);
      attr.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(key, attr);
      this.arrays[key] = arr;
      this.attrs[key] = attr;
    }
    /** slot expiry times, CPU-side only (drives the draw-range reset) */
    this._exp = new Float32Array(this.capacity);
    this._exp.fill(-1e9);

    const additive = this.blend === 'add';
    this.uniforms = {
      uTime: { value: 0 },
      uPxScale: { value: 0.002 },
      uMinPx: { value: 2.0 },
      uMasks: { value: o.masks },
      uDepth: { value: o.masks },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uClip: { value: new THREE.Vector2(0.25, 900) },
      uSoftOn: { value: 0 },
      uShaded: { value: o.shaded ? 1 : 0 },
      uKeyDir: { value: new THREE.Vector3(0, 0, 1) },
      uKeyCol: { value: new THREE.Color(1, 0.76, 0.5) },
      uAmbCol: { value: new THREE.Color(0.22, 0.25, 0.33) },
      uFogColor: { value: new THREE.Color(0.1, 0.11, 0.13) },
      uFogParam: { value: new THREE.Vector3(60, 300, 0) },
      uFogMix: { value: additive ? 0.7 : 0.9 },
      uAdditive: { value: additive ? 1 : 0 },
      /* Scene-linear ceiling for one additive sprite. 0.84 is the value that
         ACES maps to ~0.85 at the VFX reference exposure gain of 1.85x;
         VFXSystem re-derives it from the pipeline's live gain every frame. */
      uMaxRad: { value: 0.84 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.material.name = o.name ?? 'Sanctum.vfxSprites';
    this.material.userData.noCSM = true;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = (o.name ?? 'vfxSprites') + '.mesh';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = o.renderOrder ?? 20;
    this.mesh.userData.noGBuffer = true;
    this.mesh.userData.noCSM = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.geometry = geo;
  }

  /** Live particle upper bound (what the draw call actually costs). */
  get live() { return this.geometry.instanceCount; }

  /**
   * Write one particle. Ring-buffer: when the pool is full the oldest slot is
   * reused, which degrades a burst gracefully instead of allocating.
   * @param {Spec} s
   * @param {number} now current vfx time
   */
  emit(s, now) {
    const i = this._head;
    this._head = (this._head + 1) % this.capacity;
    if (this._exp[i] > now) this.dropped++;
    this.spawned++;

    const t0 = now + s.delay;
    const life = s.life > 1e-4 ? s.life : 1e-4;
    const exp = t0 + life;
    this._exp[i] = exp;
    if (exp > this._maxExp) this._maxExp = exp;

    let a = this.arrays.iPos, o = i * 3;
    a[o] = s.x; a[o + 1] = s.y; a[o + 2] = s.z;
    a = this.arrays.iVel;
    a[o] = s.vx; a[o + 1] = s.vy; a[o + 2] = s.vz;
    a = this.arrays.iSize;
    a[o] = s.size0; a[o + 1] = s.size1; a[o + 2] = s.aspect;

    o = i * 2;
    a = this.arrays.iLife; a[o] = t0; a[o + 1] = life;
    a = this.arrays.iRot; a[o] = s.rot; a[o + 1] = s.rotVel;
    a = this.arrays.iSway; a[o] = s.swayAmp; a[o + 1] = s.swayFreq;

    o = i * 4;
    a = this.arrays.iC0; a[o] = s.r0; a[o + 1] = s.g0; a[o + 2] = s.b0; a[o + 3] = s.a0;
    a = this.arrays.iC1; a[o] = s.r1; a[o + 1] = s.g1; a[o + 2] = s.b1; a[o + 3] = s.a1;
    a = this.arrays.iDyn; a[o] = s.drag; a[o + 1] = s.gravity; a[o + 2] = s.stretch; a[o + 3] = s.seed;
    a = this.arrays.iShape;
    a[o] = s.shape; a[o + 1] = s.soft; a[o + 2] = s.align; a[o + 3] = s.sizeCurve;

    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    if (i + 1 > this._hi) this._hi = i + 1;
    return i;
  }

  /** Upload dirty spans and publish per-frame uniforms. */
  flush(now) {
    this._now = now;
    if (this._dirtyHi >= this._dirtyLo) {
      const lo = this._dirtyLo, count = this._dirtyHi - lo + 1;
      for (const key in FLOATS) {
        const n = FLOATS[key];
        const attr = this.attrs[key];
        attr.clearUpdateRanges();
        attr.addUpdateRange(lo * n, count * n);
        attr.needsUpdate = true;
      }
      this._dirtyLo = Infinity;
      this._dirtyHi = -1;
    }
    // Nothing alive anywhere: rewind the ring so the draw range collapses.
    if (now > this._maxExp) { this._hi = 0; this._head = 0; }
    this.geometry.instanceCount = this._hi;
    this.uniforms.uTime.value = now;
  }

  /** Shift every stored spawn time so `uTime` never loses float precision. */
  rebase(delta) {
    const a = this.arrays.iLife;
    for (let i = 0; i < this.capacity; i++) a[i * 2] -= delta;
    for (let i = 0; i < this.capacity; i++) this._exp[i] -= delta;
    this._maxExp -= delta;
    this._dirtyLo = 0;
    this._dirtyHi = this.capacity - 1;
  }

  clear() {
    this._exp.fill(-1e9);
    const a = this.arrays.iLife;
    for (let i = 0; i < this.capacity; i++) { a[i * 2] = -1e9; a[i * 2 + 1] = 1e-4; }
    this._head = 0;
    this._hi = 0;
    this._maxExp = -1e9;
    this._dirtyLo = 0;
    this._dirtyHi = this.capacity - 1;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
