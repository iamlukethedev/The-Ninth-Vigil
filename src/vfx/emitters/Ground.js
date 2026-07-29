import * as THREE from 'three';

/**
 * SANCTUM — ground-projected reads: telegraphs and stains.
 *
 * This is the layer that tells the player where an attack is going to land, and
 * the layer that remembers a fight happened. Both are flat quads lying on the
 * XZ plane with the shape evaluated as an SDF in the fragment shader, so:
 *
 *  - the edge is soft and anti-aliased at any size,
 *  - a telegraph can *fill* over its windup with a bright leading rim,
 *  - a stain can be eroded by noise so it never reads as a perfect circle,
 *  - and every quad fades where the surface underneath it drops away from the
 *    quad's own plane (sampled from the depth prepass), which is what stops it
 *    floating over a step or slicing through a kerb.
 *
 * `Decals` owns the projected version; this is the additive/soft screen read
 * that must exist whether or not that module is present, and telegraphs are
 * announced to it as well so the two can agree.
 *
 * One InstancedBufferGeometry, one draw call, fixed pool.
 */

export const GSHAPE = {
  DISC: 0,
  RING: 1,
  CONE: 2,
  RECT: 3,
  STAIN: 4,
  GLYPH: 5,
};

const VERT = /* glsl */`
precision highp float;

uniform float uTime;

attribute vec3 gPos;
attribute vec4 gSize;    // (halfX, halfZ, cos yaw, sin yaw)
attribute vec2 gLife;    // (t0, life)
attribute vec4 gShape;   // (shape, inner ratio, half angle, softness)
attribute vec4 gColA;    // (rgb, opacity)
attribute vec4 gColB;    // (rim rgb, rim gain)
attribute vec4 gProg;    // (progress, seed, fadeIn, fadeOut)

varying vec2 vLocal;     // metres from the centre, in the quad's own frame
varying vec2 vHalf;
varying vec4 vShape;
varying vec4 vColA;
varying vec4 vColB;
varying vec3 vProg;
varying float vViewZ;
varying float vEnv;

void main() {
  float age = uTime - gLife.x;
  float life = max( gLife.y, 1e-4 );
  float u = age / life;
  if ( u < 0.0 || u >= 1.0 || gColA.a <= 0.0 ) {
    vLocal = vec2( 0.0 ); vHalf = vec2( 1.0 ); vShape = vec4( 0.0 );
    vColA = vec4( 0.0 ); vColB = vec4( 0.0 ); vProg = vec3( 0.0 );
    vViewZ = -1.0; vEnv = 0.0;
    gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
    return;
  }

  vec2 hsz = gSize.xy;
  vec2 corner = position.xy * 2.0;      // -1..1
  vec2 local = corner * hsz;
  float c = gSize.z, s = gSize.w;
  vec3 wp = gPos + vec3( local.x * c - local.y * s, 0.0, local.x * s + local.y * c );

  vec4 mv = modelViewMatrix * vec4( wp, 1.0 );
  vViewZ = mv.z;
  vLocal = local;
  vHalf = hsz;
  vShape = gShape;
  vColA = gColA;
  vColB = gColB;
  vProg = vec3( gProg.x, gProg.y, u );
  vEnv = smoothstep( 0.0, max( gProg.z, 1e-4 ), u ) *
         ( 1.0 - smoothstep( 1.0 - max( gProg.w, 1e-4 ), 1.0, u ) );

  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uMasks;
uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uClip;
uniform float uSoftOn;
uniform float uTime;

varying vec2 vLocal;
varying vec2 vHalf;
varying vec4 vShape;
varying vec4 vColA;
varying vec4 vColB;
varying vec3 vProg;
varying float vViewZ;
varying float vEnv;

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

void main() {
  int sh = int( vShape.x + 0.5 );
  float R = max( vHalf.x, 1e-3 );
  float r = length( vLocal );
  float soft = max( vShape.w, 0.02 );
  float prog = vProg.x;
  float seed = vProg.y;

  float body = 0.0;   // filled area
  float rim = 0.0;    // bright boundary

  if ( sh == 0 ) {                                  // DISC
    body = 1.0 - smoothstep( R * ( 1.0 - soft ), R, r );
    rim = 1.0 - smoothstep( 0.0, R * soft * 1.4, abs( r - R * 0.97 ) );
  } else if ( sh == 1 ) {                           // RING
    float inner = R * clamp( vShape.y, 0.0, 0.97 );
    float w = ( R - inner );
    float mid = ( R + inner ) * 0.5;
    body = 1.0 - smoothstep( w * 0.34, w * 0.55, abs( r - mid ) );
    rim = 1.0 - smoothstep( 0.0, w * 0.28, abs( r - R * 0.97 ) );
  } else if ( sh == 2 ) {                           // CONE sector
    float ang = atan( vLocal.y, vLocal.x );
    float halfAng = max( vShape.z, 0.02 );
    float da = abs( ang );
    float inAng = 1.0 - smoothstep( halfAng * 0.86, halfAng, da );
    float inRad = 1.0 - smoothstep( R * ( 1.0 - soft ), R, r );
    body = inAng * inRad;
    rim = max(
      inAng * ( 1.0 - smoothstep( 0.0, R * soft * 1.4, abs( r - R * 0.97 ) ) ),
      inRad * ( 1.0 - smoothstep( 0.0, halfAng * 0.16, abs( da - halfAng * 0.93 ) ) )
    );
  } else if ( sh == 3 ) {                           // RECT / lane
    vec2 q = abs( vLocal ) / vHalf;
    float m = max( q.x, q.y );
    body = 1.0 - smoothstep( 1.0 - soft, 1.0, m );
    rim = 1.0 - smoothstep( 0.0, soft * 1.3, abs( m - 0.97 ) );
  } else if ( sh == 4 ) {                           // STAIN — noise eroded
    vec2 nuv = vLocal / R * 0.42 + vec2( seed * 0.71, seed * 0.37 );
    float n = texture2D( uMasks, nuv ).r;
    float n2 = texture2D( uMasks, nuv * 2.7 ).b;
    float f = sat( 1.0 - r / R );
    body = smoothstep( 0.26, 0.58, f * ( 0.5 + n * 0.85 + n2 * 0.3 ) );
    rim = smoothstep( 0.30, 0.44, f * ( 0.5 + n * 0.85 ) ) - body;
    rim = sat( rim ) * 1.6;
  } else {                                          // GLYPH — rune circle
    float ang = atan( vLocal.y, vLocal.x );
    float ringA = 1.0 - smoothstep( 0.0, R * 0.05, abs( r - R * 0.94 ) );
    float ringB = 1.0 - smoothstep( 0.0, R * 0.04, abs( r - R * 0.66 ) );
    float ticks = pow( abs( cos( ang * 6.0 + seed * 6.28 ) ), 26.0 )
                * ( 1.0 - smoothstep( 0.0, R * 0.16, abs( r - R * 0.80 ) ) );
    float inner = ( 1.0 - smoothstep( R * 0.55, R * 0.66, r ) ) * 0.16;
    body = sat( inner );
    rim = sat( ringA + ringB * 0.7 + ticks );
  }

  /* --- windup fill: the area inside the progress value lights up, and the moving
         boundary is the brightest thing on screen: it is the read that makes
         a telegraph legible in half a second. --- */
  if ( prog > 0.0 ) {
    float t;
    if ( sh == 2 ) {
      float halfAng = max( vShape.z, 0.02 );
      t = sat( abs( atan( vLocal.y, vLocal.x ) ) / halfAng );
      t = 1.0 - t;                                  // fill from the centre out
    } else {
      t = sat( r / R );
    }
    float fill = 1.0 - smoothstep( prog - 0.035, prog + 0.035, t );
    float edge = 1.0 - smoothstep( 0.0, 0.055, abs( t - prog ) );
    body *= 0.30 + 0.70 * fill;
    rim = max( rim, body > 0.0 ? edge * 1.25 : 0.0 );
  }

  float a = ( body * vColA.a + rim * vColB.a ) * vEnv;
  if ( a < 0.004 ) discard;

  /* --- conform to the surface: fade out where the ground is not where this
         quad thinks it is. Without it a flat decal floats over every step. --- */
  if ( uSoftOn > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = ( uClip.x * uClip.y ) / ( ( uClip.y - uClip.x ) * d - uClip.y );
    a *= 1.0 - sat( ( vViewZ - sceneZ - 0.03 ) / 0.42 );
  }
  if ( a < 0.004 ) discard;

  vec3 col = mix( vColA.rgb, vColB.rgb, sat( rim * 1.4 ) );
  gl_FragColor = vec4( col, sat( a ) );
}
`;

const FLOATS = {
  gPos: 3, gSize: 4, gLife: 2, gShape: 4, gColA: 4, gColB: 4, gProg: 4,
};

export class GroundFX {
  constructor(o = {}) {
    this.capacity = Math.max(8, o.capacity ?? 56);
    this._head = 0;
    this._hi = 0;
    this._maxExp = -1e9;
    this._dirtyLo = Infinity;
    this._dirtyHi = -1;

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
    this._exp = new Float32Array(this.capacity);
    this._exp.fill(-1e9);

    this.uniforms = {
      uTime: { value: 0 },
      uMasks: { value: o.masks },
      uDepth: { value: o.masks },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uClip: { value: new THREE.Vector2(0.25, 900) },
      uSoftOn: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.material.name = 'Sanctum.vfxGround';
    this.material.userData.noCSM = true;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'vfxGround';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 12;      // under the particles, over the floor
    this.mesh.userData.noGBuffer = true;
    this.mesh.userData.noCSM = true;
    this.geometry = geo;

    /** slot lookup for anything that needs live updates (telegraph progress) */
    this._slotOf = new Map();
  }

  get live() { return this.geometry.instanceCount; }

  /**
   * @param {object} o
   *   x,z,y            centre (y is the ground height; the quad is lifted a hair)
   *   shape            GSHAPE.*
   *   halfX, halfZ     extents in metres
   *   yaw              rotation
   *   life, t0
   *   colour, opacity  fill
   *   rim, rimGain     boundary colour + gain
   *   inner            RING inner ratio, CONE half-angle in gShape.z
   *   progress         >0 enables the windup fill
   *   seed, fadeIn, fadeOut, soft
   *   key              optional handle for later updates
   */
  add(o, now) {
    const i = this._head;
    this._head = (this._head + 1) % this.capacity;

    const life = Math.max(0.05, o.life ?? 1);
    const t0 = o.t0 ?? now;
    const exp = t0 + life;
    this._exp[i] = exp;
    if (exp > this._maxExp) this._maxExp = exp;

    const yaw = o.yaw ?? 0;
    const hx = Math.max(0.02, o.halfX ?? 1);
    const hz = Math.max(0.02, o.halfZ ?? hx);

    let a = this.arrays.gPos, p = i * 3;
    a[p] = o.x; a[p + 1] = (o.y ?? 0) + (o.lift ?? 0.025); a[p + 2] = o.z;

    p = i * 4;
    a = this.arrays.gSize;
    a[p] = hx; a[p + 1] = hz; a[p + 2] = Math.cos(yaw); a[p + 3] = Math.sin(yaw);
    a = this.arrays.gShape;
    a[p] = o.shape ?? GSHAPE.DISC;
    a[p + 1] = o.inner ?? 0.6;
    a[p + 2] = o.angle ?? 0.7;
    a[p + 3] = o.soft ?? 0.16;
    a = this.arrays.gColA;
    const c = o.colour;
    a[p] = (c?.r ?? 1) * (o.gain ?? 1);
    a[p + 1] = (c?.g ?? 1) * (o.gain ?? 1);
    a[p + 2] = (c?.b ?? 1) * (o.gain ?? 1);
    a[p + 3] = o.opacity ?? 0.5;
    a = this.arrays.gColB;
    const rc = o.rim ?? o.colour;
    a[p] = (rc?.r ?? 1) * (o.rimIntensity ?? 1);
    a[p + 1] = (rc?.g ?? 1) * (o.rimIntensity ?? 1);
    a[p + 2] = (rc?.b ?? 1) * (o.rimIntensity ?? 1);
    a[p + 3] = o.rimGain ?? 0.6;
    a = this.arrays.gProg;
    a[p] = o.progress ?? 0;
    a[p + 1] = o.seed ?? 0;
    a[p + 2] = o.fadeIn ?? 0.06;
    a[p + 3] = o.fadeOut ?? 0.22;

    p = i * 2;
    a = this.arrays.gLife; a[p] = t0; a[p + 1] = life;

    this._touch(i);
    if (o.key !== undefined && o.key !== null) this._slotOf.set(o.key, i);
    return i;
  }

  /** Live-update an existing entry (telegraph aiming + windup progress). */
  update(key, o, now) {
    const i = this._slotOf.get(key);
    if (i === undefined) return false;
    if (this._exp[i] <= now) { this._slotOf.delete(key); return false; }
    let p = i * 3;
    let a = this.arrays.gPos;
    if (o.x !== undefined) a[p] = o.x;
    if (o.y !== undefined) a[p + 1] = o.y + (o.lift ?? 0.025);
    if (o.z !== undefined) a[p + 2] = o.z;
    p = i * 4;
    if (o.yaw !== undefined) {
      a = this.arrays.gSize;
      a[p + 2] = Math.cos(o.yaw); a[p + 3] = Math.sin(o.yaw);
    }
    if (o.progress !== undefined) {
      a = this.arrays.gProg;
      a[p] = o.progress;
    }
    this._touch(i);
    return true;
  }

  /** Retire an entry early (telegraph cancelled). */
  kill(key, now) {
    const i = this._slotOf.get(key);
    if (i === undefined) return false;
    this._slotOf.delete(key);
    if (this._exp[i] <= now) return false;
    const p = i * 2;
    // Snap its life so the tail fade takes it out over ~0.1 s.
    this.arrays.gLife[p] = now - Math.max(0, this.arrays.gLife[p + 1] - 0.10);
    this._exp[i] = now + 0.10;
    this._touch(i);
    return true;
  }

  _touch(i) {
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    if (i + 1 > this._hi) this._hi = i + 1;
  }

  flush(now) {
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
    if (now > this._maxExp) { this._hi = 0; this._head = 0; this._slotOf.clear(); }
    this.geometry.instanceCount = this._hi;
    this.uniforms.uTime.value = now;
  }

  setDepth(tex, invResX, invResY, near, far) {
    this.uniforms.uDepth.value = tex ?? this.uniforms.uMasks.value;
    this.uniforms.uSoftOn.value = tex ? 1 : 0;
    this.uniforms.uInvRes.value.set(invResX, invResY);
    this.uniforms.uClip.value.set(near, far);
  }

  rebase(delta) {
    const a = this.arrays.gLife;
    for (let i = 0; i < this.capacity; i++) a[i * 2] -= delta;
    for (let i = 0; i < this.capacity; i++) this._exp[i] -= delta;
    this._maxExp -= delta;
    this._dirtyLo = 0;
    this._dirtyHi = this.capacity - 1;
  }

  clear() {
    this._exp.fill(-1e9);
    const a = this.arrays.gLife;
    for (let i = 0; i < this.capacity; i++) { a[i * 2] = -1e9; a[i * 2 + 1] = 1e-4; }
    this._head = 0;
    this._hi = 0;
    this._maxExp = -1e9;
    this._slotOf.clear();
    this._dirtyLo = 0;
    this._dirtyHi = this.capacity - 1;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
