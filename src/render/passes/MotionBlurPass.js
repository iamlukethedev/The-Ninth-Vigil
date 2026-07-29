import * as THREE from 'three';
import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON } from './ShaderChunks.js';

const FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform mat4  uInvViewProj;
uniform mat4  uPrevViewProj;
uniform float uIntensity;
uniform float uMaxRadius;
uniform float uNear;
uniform float uFar;

varying vec2 vUv;

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  if ( uIntensity <= 0.0 ) { gl_FragColor = base; return; }

  float d = texture2D( tDepth, vUv ).x;

  // Reproject this pixel through last frame's camera to get its screen velocity.
  vec4 clip = vec4( vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0 );
  vec4 world = uInvViewProj * clip;
  world /= ( abs( world.w ) < 1.0e-8 ? 1.0e-8 : world.w );

  vec4 prevClip = uPrevViewProj * world;
  if ( prevClip.w <= 0.0 ) { gl_FragColor = base; return; }
  vec2 prevUv = ( prevClip.xy / prevClip.w ) * 0.5 + 0.5;

  vec2 vel = ( vUv - prevUv ) * uIntensity;
  float len = length( vel );
  if ( len < 0.0006 ) { gl_FragColor = base; return; }
  if ( len > uMaxRadius ) vel *= uMaxRadius / len;

  // Symmetric shutter sweep, dithered start so 7 taps read as a smear and not
  // as ghost copies.
  float jitter = ign( gl_FragCoord.xy ) - 0.5;
  vec3 acc = base.rgb;
  float wsum = 1.0;
  for ( int i = 1; i < MB_TAPS; i ++ ) {
    float f = ( float( i ) + jitter ) / float( MB_TAPS - 1 ) - 0.5;
    vec2 uv = clamp( vUv + vel * f, vec2( 0.0 ), vec2( 1.0 ) );
    float w = 1.0 - abs( f ) * 0.9;
    acc += texture2D( tDiffuse, uv ).rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4( acc / wsum, base.a );
}
`;

/**
 * Camera-velocity motion blur.
 *
 * Reconstructs world position from the shared depth buffer and reprojects it
 * with last frame's view-projection. Deterministic (both matrices come from the
 * fixed-step simulation), clamped to a few pixels, and skipped entirely for a
 * couple of frames after a camera teleport so scenario switches never smear.
 */
export class MotionBlurPass extends QuadPass {
  constructor({ camera, depthTexture, params, taps = 7 }) {
    super(
      FRAG,
      {
        tDiffuse: { value: null },
        tDepth: { value: depthTexture },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uIntensity: { value: 0.5 },
        uMaxRadius: { value: 0.012 },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
      },
      { MB_TAPS: taps },
      'Sanctum.MotionBlur'
    );
    this.camera = camera;
    this.params = params;
    this.needsSwap = true;

    this._viewProj = new THREE.Matrix4();
    this._prevViewProj = new THREE.Matrix4();
    this._invViewProj = new THREE.Matrix4();
    this._skip = 2;
    this._primed = false;
  }

  setDepthTexture(depthTexture) {
    this.uniforms.tDepth.value = depthTexture;
  }

  /** Drop history — call on scenario changes / camera teleports. */
  reset() {
    this._skip = 2;
    this._primed = false;
  }

  /** Call once per rendered frame, before the composer runs. */
  updateMatrices() {
    const cam = this.camera;
    cam.updateMatrixWorld();
    if (this._primed) this._prevViewProj.copy(this._viewProj);
    this._viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._invViewProj.copy(this._viewProj).invert();
    if (!this._primed) {
      this._prevViewProj.copy(this._viewProj);
      this._primed = true;
    }
    if (this._skip > 0) {
      this._skip--;
      this._prevViewProj.copy(this._viewProj);
    }
  }

  beforeRender() {
    const p = this.params;
    this.uniforms.uInvViewProj.value.copy(this._invViewProj);
    this.uniforms.uPrevViewProj.value.copy(this._prevViewProj);
    this.uniforms.uIntensity.value = p.motionBlur;
    this.uniforms.uMaxRadius.value = p.motionBlurMax;
    this.uniforms.uNear.value = this.camera.near;
    this.uniforms.uFar.value = this.camera.far;
  }
}
