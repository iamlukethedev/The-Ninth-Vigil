import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { QuadRenderer, quadMaterial } from './QuadPass.js';
import { GLSL_COMMON, GLSL_BILATERAL } from './ShaderChunks.js';

const RAY_FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tColor;
uniform sampler2D tDepth;

uniform vec2  uLightUV;
uniform vec3  uLightColor;
uniform float uDensity;
uniform float uWeight;
uniform float uDecay;
uniform float uThreshold;
uniform float uSkyWeight;
uniform float uSourceGain;
uniform float uOnScreen;
uniform float uFalloff;
uniform float uNearGate;
uniform float uNear;
uniform float uFar;
uniform float uAspect;
uniform float uMaxAdd;
uniform float uSrcRadius;
uniform float uOcclude;

varying vec2 vUv;

void main() {

  if ( uOnScreen <= 0.001 || uWeight <= 0.0 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec2 delta = ( vUv - uLightUV ) * ( uDensity / float( VOL_SAMPLES ) );

  // Dithered start offset kills the concentric banding of a fixed step march.
  // It is spatial only (no frame term) so stepped frames never shimmer.
  float jitter = ign( gl_FragCoord.xy );
  vec2 uv = vUv - delta * jitter;

  float illum = 1.0;
  vec3 acc = vec3( 0.0 );

  for ( int i = 0; i < VOL_SAMPLES; i ++ ) {
    uv -= delta;
    vec2 cuv = clamp( uv, vec2( 0.0 ), vec2( 1.0 ) );

    float d = texture2D( tDepth, cuv ).x;
    vec3 c = texture2D( tColor, cuv ).rgb;

    // A sample only emits if it is open sky or a genuinely bright emitter
    // (torch flame, hellfire, spell core) — never mid-tone geometry.
    float lc = luma( c );
    float sky = step( 0.999999, d ) * uSkyWeight;
    float bright = smoothstep( uThreshold, uThreshold * 3.2, lc );

    /* A radial march smears EVERY bright pixel it crosses along the line back
       to the source. In a torchlit crypt with a dozen practicals on screen that
       produced a dozen straight streaks converging on one point — pure lens
       artefact, and an instant post-processing fail. Point emitters therefore
       only contribute inside a small window around the source the pipeline
       actually chose; open sky (a directional shaft) still emits everywhere. */
    float rs = length( ( cuv - uLightUV ) * vec2( uAspect, 1.0 ) );
    float srcWin = 1.0 - smoothstep( uSrcRadius * 0.55, uSrcRadius, rs );
    float src = max( sky, bright * uSourceGain * srcWin );

    // Take the hue from what is actually glowing so hellfire scatters orange
    // and a moonlit window scatters blue, with the light colour as the anchor.
    vec3 chroma = clamp( c / max( lc, 1.0e-4 ), vec3( 0.0 ), vec3( 2.5 ) );
    acc += mix( uLightColor, chroma, 0.6 ) * src * illum;

    /* Occlusion. A screen-space radial march has no idea that a wall stands
       between the pixel and the sky: with illum decaying at a constant rate,
       every fragment in the frame accumulated the sky samples that happen to lie
       along its line back to the source, and the result was a flat veil over the
       whole image rather than shafts. Measured on boss: mean 0.057 -> 0.283 with
       0.1 % of the frame left at true black, i.e. the milky-blacks instant fail.
       Attenuating hard whenever the march crosses opaque mid-tone geometry is what
       makes a shaft stop at a wall — and what keeps the shadows black. */
    float occ = 1.0 - clamp( max( sky, bright ), 0.0, 1.0 );
    illum *= mix( uDecay, uDecay * uOcclude, occ );
  }

  acc *= uWeight / float( VOL_SAMPLES );

  // Shafts live in the air: geometry right in front of the camera keeps its
  // contrast instead of being washed by inscatter.
  float dist = linearDist( texture2D( tDepth, vUv ).x, uNear, uFar );
  acc *= mix( uNearGate, 1.0, smoothstep( 1.0, 14.0, dist ) );

  // Radial falloff from the source so the glow is a shaft, not a screen wash.
  float r = length( ( vUv - uLightUV ) * vec2( uAspect, 1.0 ) );
  acc *= exp( -r * uFalloff );
  acc *= uOnScreen;

  gl_FragColor = vec4( min( acc, vec3( uMaxAdd ) ), 1.0 );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BILATERAL}

uniform sampler2D tDiffuse;
uniform sampler2D tVol;
uniform sampler2D tDepth;
uniform vec2  uVolTexel;
uniform float uNear;
uniform float uFar;
uniform float uMaxAdd;

varying vec2 vUv;

void main() {
  vec4 base = texture2D( tDiffuse, vUv );

  float dRaw = texture2D( tDepth, vUv ).x;
  float centerDist = linearDist( dRaw, uNear, uFar );
  vec3 shaft = bilateralUpsample( tVol, tDepth, vUv, uVolTexel, centerDist, 1.5, uNear, uFar ).rgb;

  gl_FragColor = vec4( base.rgb + min( shaft, vec3( uMaxAdd ) ), base.a );
}
`;

/**
 * Depth-aware volumetric light shafts.
 *
 * Radial occlusion march from the dominant light's screen position with
 * dithered sampling. Emitters are sky pixels and genuinely bright HDR pixels
 * (torches, hellfire), so it works in an enclosed crypt as well as under an
 * open sky. Additive, clamped, and gated on depth so it never blows out.
 */
export class VolumetricPass extends Pass {
  constructor({ camera, depthTexture, params, samples = 28 }) {
    super();
    this.camera = camera;
    this.params = params;
    this.needsSwap = true;
    this.scale = 0.5;
    this._q = new QuadRenderer();

    this.target = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'Nona.godrays';

    this.rayMaterial = quadMaterial(
      'Nona.Godrays',
      RAY_FRAG,
      {
        tColor: { value: null },
        tDepth: { value: depthTexture },
        uLightUV: { value: new THREE.Vector2(0.5, 0.72) },
        uLightColor: { value: new THREE.Color(1.0, 0.72, 0.42) },
        uDensity: { value: 0.82 },
        uWeight: { value: 0.42 },
        uDecay: { value: 0.965 },
        uThreshold: { value: 1.05 },
        uSkyWeight: { value: 0.85 },
        uSourceGain: { value: 1.0 },
        uOnScreen: { value: 1.0 },
        uFalloff: { value: 1.35 },
        uNearGate: { value: 0.45 },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uAspect: { value: 1.777 },
        uMaxAdd: { value: 1.6 },
        uSrcRadius: { value: 0.12 },
        uOcclude: { value: 0.55 },
      },
      { VOL_SAMPLES: samples }
    );

    this.compositeMaterial = quadMaterial('Nona.GodraysComposite', COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tVol: { value: this.target.texture },
      tDepth: { value: depthTexture },
      uVolTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uMaxAdd: { value: 1.6 },
    });
  }

  setDepthTexture(depthTexture) {
    this.rayMaterial.uniforms.tDepth.value = depthTexture;
    this.compositeMaterial.uniforms.tDepth.value = depthTexture;
  }

  /**
   * @param {THREE.Vector2} uv    light position in screen uv
   * @param {THREE.Color}   color light tint
   * @param {number}        onScreen 0..1 visibility weight
   */
  setSource(uv, color, onScreen) {
    this.rayMaterial.uniforms.uLightUV.value.copy(uv);
    this.rayMaterial.uniforms.uLightColor.value.copy(color);
    this.rayMaterial.uniforms.uOnScreen.value = onScreen;
  }

  setSize(width, height) {
    const w = Math.max(4, Math.round(width * this.scale));
    const h = Math.max(4, Math.round(height * this.scale));
    this.target.setSize(w, h);
    this.compositeMaterial.uniforms.uVolTexel.value.set(1 / w, 1 / h);
    this.rayMaterial.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const p = this.params;
    const u = this.rayMaterial.uniforms;
    u.tColor.value = readBuffer.texture;
    u.uDensity.value = p.volDensity;
    u.uWeight.value = p.volWeight;
    u.uDecay.value = p.volDecay;
    u.uThreshold.value = p.volThreshold;
    u.uSkyWeight.value = p.volSkyWeight;
    u.uSourceGain.value = p.volSourceGain;
    u.uFalloff.value = p.volFalloff;
    u.uNearGate.value = p.volNearGate;
    u.uMaxAdd.value = p.volMaxAdd;
    u.uSrcRadius.value = p.volSourceRadius ?? 0.12;
    u.uOcclude.value = p.volOcclude ?? 0.55;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;

    const c = this.compositeMaterial.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.uNear.value = this.camera.near;
    c.uFar.value = this.camera.far;
    c.uMaxAdd.value = p.volMaxAdd;

    this._q.render(renderer, this.rayMaterial, this.target);
    this._q.render(renderer, this.compositeMaterial, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.target.dispose();
    this.rayMaterial.dispose();
    this.compositeMaterial.dispose();
    this._q.dispose();
  }
}
