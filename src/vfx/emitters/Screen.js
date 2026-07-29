import * as THREE from 'three';

/**
 * SANCTUM — screen-space VFX finish.
 *
 * Three effects that cannot be done with geometry, all in one pass over the
 * resolved frame:
 *
 *  1. **Heat distortion.** Real refraction, not a haze card: the resolved frame
 *     is copied to a texture and re-sampled with a per-pixel UV offset driven by
 *     a turbulence field, masked to the screen-space footprint of whatever heat
 *     sources are registered this frame. This is the only honest way to do it —
 *     the composite is already finished by the time a fire is on screen, so the
 *     distortion has to read the finished image.
 *  2. **Chromatic pulse on a heavy hit.** A brief radial R/B split on top of the
 *     pipeline's own restrained CA (which is left alone; the pulse is additive
 *     and decays to nothing in under a third of a second).
 *  3. **Low-health blood vignette.** A radial oxide-red darkening that only
 *     exists below a health threshold, deliberately subtle — it must read as
 *     pressure, not as a filter.
 *
 * The pass is *skipped entirely* when nothing is active, so it costs zero on a
 * normal frame. When it does run it is one framebuffer copy plus one fullscreen
 * quad.
 */

const MAX_HEAT = 4;

const VERT = /* glsl */`
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy * 2.0, 0.0, 1.0 );
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D tFrame;
uniform vec4 uHeat[ ${MAX_HEAT} ];   // (screen x, screen y, radius, strength)
uniform int uHeatCount;
uniform float uTime;
uniform float uCA;
uniform float uBlood;
uniform float uAspect;

varying vec2 vUv;

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

/** Cheap 3-lobe turbulence — deterministic, no texture fetch. */
vec2 turb( vec2 p, float t ) {
  float a = sin( p.y * 34.0 + t * 5.1 ) + sin( p.y * 71.0 - t * 3.3 ) * 0.5;
  float b = sin( p.x * 41.0 - t * 4.4 ) + sin( p.x * 83.0 + t * 6.1 ) * 0.5;
  float c = sin( ( p.x + p.y ) * 57.0 + t * 7.7 );
  return vec2( a * 0.6 + c * 0.4, b * 0.7 + c * 0.3 );
}

void main() {
  vec2 uv = vUv;
  vec2 off = vec2( 0.0 );

  for ( int i = 0; i < ${MAX_HEAT}; i++ ) {
    if ( i >= uHeatCount ) break;
    vec4 h = uHeat[ i ];
    if ( h.w <= 0.0 ) continue;
    vec2 d = ( uv - h.xy ) * vec2( uAspect, 1.0 );
    float r = length( d ) / max( h.z, 1e-4 );
    if ( r >= 1.0 ) continue;
    // Rising column: the field scrolls upward and widens with height.
    float fall = pow( 1.0 - r, 2.0 );
    float lift = sat( ( uv.y - h.y ) / max( h.z, 1e-4 ) * 0.5 + 0.5 );
    off += turb( uv * vec2( 1.0, 0.55 ) - vec2( 0.0, uTime * 0.22 ), uTime )
         * ( h.w * fall * ( 0.45 + lift * 0.9 ) * 0.0018 );
  }

  vec2 suv = clamp( uv + off, vec2( 0.0005 ), vec2( 0.9995 ) );
  vec3 col;

  if ( uCA > 0.0001 ) {
    // Radial split, strongest at the edges — a hit felt, not a lens defect.
    vec2 c = suv - 0.5;
    float k = uCA * ( 0.25 + dot( c, c ) * 2.2 );
    col.r = texture2D( tFrame, clamp( suv + c * k, vec2( 0.0005 ), vec2( 0.9995 ) ) ).r;
    col.g = texture2D( tFrame, suv ).g;
    col.b = texture2D( tFrame, clamp( suv - c * k, vec2( 0.0005 ), vec2( 0.9995 ) ) ).b;
  } else {
    col = texture2D( tFrame, suv ).rgb;
  }

  if ( uBlood > 0.001 ) {
    vec2 c = ( uv - 0.5 ) * vec2( uAspect, 1.0 );
    float v = sat( ( length( c ) - 0.30 ) / 0.52 );
    v = v * v;
    float pulse = 0.82 + 0.18 * sin( uTime * 3.4 );
    float k = v * uBlood * pulse;
    vec3 bruise = col * vec3( 0.42, 0.055, 0.06 );
    col = mix( col, bruise, sat( k * 1.15 ) );
    col += vec3( 0.055, 0.0, 0.004 ) * k;
  }

  gl_FragColor = vec4( col, 1.0 );
}
`;

export class ScreenFX {
  constructor() {
    this.width = 2;
    this.height = 2;
    this.frameTex = null;

    this.uniforms = {
      tFrame: { value: null },
      uHeat: { value: [] },
      uHeatCount: { value: 0 },
      uTime: { value: 0 },
      uCA: { value: 0 },
      uBlood: { value: 0 },
      uAspect: { value: 1.777 },
    };
    for (let i = 0; i < MAX_HEAT; i++) this.uniforms.uHeat.value.push(new THREE.Vector4());

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this.material.name = 'Sanctum.vfxScreen';
    this.material.userData.noCSM = true;

    const geo = new THREE.PlaneGeometry(1, 1);
    this.quad = new THREE.Mesh(geo, this.material);
    this.quad.frustumCulled = false;
    this.quad.matrixAutoUpdate = false;
    this.geometry = geo;

    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.Camera();

    this.heatCount = 0;
    this.ca = 0;
    this.blood = 0;
    this.failed = false;
  }

  setSize(w, h) {
    const iw = Math.max(2, w | 0), ih = Math.max(2, h | 0);
    if (iw === this.width && ih === this.height && this.frameTex) return;
    this.width = iw;
    this.height = ih;
    this.frameTex?.dispose();
    const tex = new THREE.FramebufferTexture(iw, ih);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.NoColorSpace;
    tex.name = 'Sanctum.vfxFrame';
    this.frameTex = tex;
    this.uniforms.tFrame.value = tex;
    this.uniforms.uAspect.value = iw / ih;
  }

  /** True when at least one effect would change a pixel. */
  get active() {
    return !this.failed && (this.heatCount > 0 || this.ca > 0.0004 || this.blood > 0.002);
  }

  /**
   * Copy the resolved frame and re-composite it. Restores every renderer flag
   * it touches; if anything throws the pass disables itself permanently rather
   * than corrupting later frames.
   */
  render(renderer) {
    if (!this.active || !this.frameTex) return;
    const size = renderer.getDrawingBufferSize(_size);
    if (size.x !== this.width || size.y !== this.height) this.setSize(size.x, size.y);

    const autoClear = renderer.autoClear;
    const target = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(this.frameTex);
      this.uniforms.uHeatCount.value = this.heatCount;
      this.uniforms.uCA.value = this.ca;
      this.uniforms.uBlood.value = this.blood;
      renderer.autoClear = false;
      renderer.render(this.scene, this.camera);
    } catch (e) {
      this.failed = true;
      console.warn('[vfx] screen pass disabled —', e?.message ?? e);
    } finally {
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(target);
    }
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.frameTex?.dispose();
    this.frameTex = null;
  }
}

const _size = new THREE.Vector2();
