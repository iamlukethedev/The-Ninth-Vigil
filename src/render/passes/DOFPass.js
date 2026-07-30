import * as THREE from 'three';
import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON } from './ShaderChunks.js';

/**
 * Circle-of-confusion depth of field.
 *
 * three's BokehPass was replaced here on purpose. Its shader is *symmetric*
 * (`clamp( ( focus + viewZ ) * aperture, -maxblur, maxblur )`) so the near and
 * far fields always blur by the same saturated amount, and its 41 taps at a
 * radius of only ~1.5 px act as a full-frame low pass. That is a macro-lens
 * behaviour, and it is what turned every gameplay frame in this project into a
 * shallow-focus mush: it halved the measured Laplacian sharpness of `overworld`
 * (10.7 -> 4.9) all on its own.
 *
 * This pass instead builds an explicit CoC from linear view distance, with the
 * near and far lobes authored independently:
 *
 *   coc = smoothstep( farStart,  farEnd,  dist )            * farStrength
 *       + smoothstep( nearStart, nearEnd, focus - dist )    * nearStrength
 *
 * so an ARPG framing can have `nearStrength = 0` and a far lobe that only
 * begins well past the play space — a slight aerial softening of the deep
 * background, which is all a 28 m isometric camera is entitled to. `closeup`
 * turns both lobes on and gets real, obvious bokeh.
 *
 * The gather is a golden-angle spiral whose ring count follows the radius, and
 * each tap is weighted by its own CoC so a sharp foreground never bleeds over a
 * blurred background. Sub-0.4 px CoC early-outs to the untouched sample, which
 * is both correct and what makes the gameplay path nearly free.
 *
 * Deterministic: the per-pixel spiral rotation comes from interleaved gradient
 * noise on gl_FragCoord, so it is stable frame to frame.
 */

const FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2  uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocus;
uniform vec3  uFarBand;    // start, end, strength   (view distance, metres)
uniform vec3  uNearBand;   // start, end, strength   (metres in FRONT of focus)
uniform float uMaxRadius;  // pixels

varying vec2 vUv;

float cocAt( float dist ) {
  float c = smoothstep( uFarBand.x, uFarBand.y, dist ) * uFarBand.z;
  c += smoothstep( uNearBand.x, uNearBand.y, uFocus - dist ) * uNearBand.z;
  return clamp( c, 0.0, 1.0 );
}

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float dist = linearDist( texture2D( tDepth, vUv ).x, uNear, uFar );
  float coc = cocAt( dist );
  float r = coc * uMaxRadius;

  // Below ~0.4 px there is nothing to gather: leave the pixel alone. In
  // gameplay framings this is most of the frame, so the pass costs almost
  // nothing and — crucially — removes nothing.
  if ( r < 0.4 ) { gl_FragColor = base; return; }

  float rot = ign( gl_FragCoord.xy ) * 6.2831853;
  vec3 acc = base.rgb;
  float wsum = 1.0;

  const float GA = 2.3999632;   // golden angle
  for ( int i = 1; i <= DOF_TAPS; i ++ ) {
    float fi = float( i );
    float a = rot + fi * GA;
    // sqrt distribution => uniform area coverage over the disc
    float rr = r * sqrt( fi / float( DOF_TAPS ) );
    vec2 uv = vUv + vec2( cos( a ), sin( a ) ) * rr * uTexel;
    float sd = linearDist( texture2D( tDepth, uv ).x, uNear, uFar );
    float sc = cocAt( sd );
    // A tap may only contribute if it is at least as out of focus as we are —
    // this is what stops a crisp foreground smearing across the background.
    float w = clamp( sc / max( coc, 1e-3 ), 0.0, 1.0 );
    w *= w;
    acc += texture2D( tDiffuse, uv ).rgb * w;
    wsum += w;
  }

  gl_FragColor = vec4( acc / wsum, base.a );
}
`;

export class DOFPass extends QuadPass {
  /**
   * @param {THREE.Scene} scene unused; kept so the construction site reads the
   *   same as three's BokehPass and the pipeline needs no special-casing.
   */
  constructor(scene, camera, depthTexture, params, taps = 22) {
    super(
      FRAG,
      {
        tDiffuse: { value: null },
        tDepth: { value: depthTexture },
        uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocus: { value: 20 },
        uFarBand: { value: new THREE.Vector3(48, 140, 0.55) },
        uNearBand: { value: new THREE.Vector3(1e6, 1e6 + 1, 0) },
        uMaxRadius: { value: 2.0 },
      },
      { DOF_TAPS: Math.max(6, taps | 0) },
      'Nona.DOF'
    );
    this.camera = camera;
    this.params = params;
    this.focusDistance = 20;
    this.needsSwap = true;
  }

  setDepthTexture(depthTexture) {
    this.uniforms.tDepth.value = depthTexture;
  }

  /** @param {number} d world-space distance from the camera to the focal subject */
  setFocus(d) {
    this.focusDistance = d;
  }

  beforeRender() {
    const p = this.params;
    const f = Math.max(0.5, this.focusDistance);
    const u = this.uniforms;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uFocus.value = f;

    // Bands are authored as multiples of the focal distance so one profile
    // works at 6.5 m (closeup) and at 42 m (overworld) without re-tuning.
    const fs = p.dofFarStart ?? 1.8;
    const fe = p.dofFarEnd ?? 4.6;
    u.uFarBand.value.set(f * fs, f * Math.max(fe, fs + 0.05), p.dofFarStrength ?? 0.55);

    const ns = p.dofNearStrength ?? 0;
    if (ns > 0.001) {
      // Near band is "how far in front of the focal plane", also as a fraction
      // of the focal distance.
      const a = f * (p.dofNearStart ?? 0.10);
      const b = f * Math.max(p.dofNearEnd ?? 0.45, (p.dofNearStart ?? 0.10) + 0.02);
      u.uNearBand.value.set(a, b, ns);
    } else {
      u.uNearBand.value.set(1e6, 1e6 + 1, 0);
    }

    // dofStrength is a global artistic multiplier; 1.0 = the profile as authored.
    const k = Math.max(0, Math.min(3, p.dofStrength ?? 1));
    u.uMaxRadius.value = Math.max(0, (p.dofMaxRadius ?? 2.0) * k);
  }
}
