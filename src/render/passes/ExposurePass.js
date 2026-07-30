import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { QuadPass, QuadRenderer, quadMaterial } from './QuadPass.js';
import { GLSL_COMMON } from './ShaderChunks.js';

const LUM_FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tHDR;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  vec3 c = texture2D( tHDR, vUv ).rgb;
  c += texture2D( tHDR, vUv + vec2( uTexel.x * 1.5, 0.0 ) ).rgb;
  c += texture2D( tHDR, vUv - vec2( uTexel.x * 1.5, 0.0 ) ).rgb;
  c += texture2D( tHDR, vUv + vec2( 0.0, uTexel.y * 1.5 ) ).rgb;
  c += texture2D( tHDR, vUv - vec2( 0.0, uTexel.y * 1.5 ) ).rgb;
  c *= 0.2;

  float l = clamp( luma( c ), 1.0e-4, 64.0 );

  // Centre-weighted metering: the hero and the action drive exposure, not a
  // bright wall in the corner.
  float d = length( vUv - 0.5 ) * 1.41421356;
  float w = mix( 1.0, 0.25, smoothstep( 0.18, 0.98, d ) );

  gl_FragColor = vec4( log2( l ) * w, w, 0.0, 1.0 );
}
`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uSrcTexel;
varying vec2 vUv;

void main() {
  vec4 s = vec4( 0.0 );
  for ( int y = 0; y < 4; y ++ ) {
    for ( int x = 0; x < 4; x ++ ) {
      vec2 o = ( vec2( float( x ), float( y ) ) - 1.5 ) * uSrcTexel;
      s += texture2D( tSrc, vUv + o );
    }
  }
  gl_FragColor = s * 0.0625;
}
`;

const ADAPT_FRAG = /* glsl */ `
uniform sampler2D tLum;
uniform sampler2D tPrev;
uniform float uDt;
uniform float uUpRate;
uniform float uDownRate;
uniform float uSeed;
varying vec2 vUv;

void main() {
  vec2 s = texture2D( tLum, vec2( 0.5 ) ).rg;
  float cur = s.r / max( s.g, 1.0e-5 );
  float prev = texture2D( tPrev, vec2( 0.5 ) ).r;

  float rate = cur > prev ? uUpRate : uDownRate;
  float k = clamp( 1.0 - exp( -max( uDt, 0.0 ) * rate ), 0.0, 1.0 );
  float v = mix( prev, cur, k );
  v = mix( v, cur, clamp( uSeed, 0.0, 1.0 ) );

  gl_FragColor = vec4( clamp( v, -14.0, 8.0 ), 0.0, 0.0, 1.0 );
}
`;

const APPLY_FRAG = /* glsl */ `
${GLSL_COMMON}
uniform sampler2D tDiffuse;
uniform sampler2D tAdapt;
uniform float uKey;
uniform float uMinGain;
uniform float uMaxGain;
uniform float uStrength;
uniform float uBias;
varying vec2 vUv;

void main() {
  float logL = texture2D( tAdapt, vec2( 0.5 ) ).r;
  float avg = exp2( logL );
  // uBias is the scenario's authored exposure, applied downstream by the tone
  // mapper — fold it in here so auto-exposure corrects around the art direction
  // instead of fighting it.
  float gain = uKey / max( avg * uBias, 1.0e-4 );
  gain = clamp( gain, uMinGain, uMaxGain );
  gain = mix( 1.0, gain, uStrength );
  vec4 base = texture2D( tDiffuse, vUv );
  gl_FragColor = vec4( base.rgb * gain, base.a );
}
`;

function lumTarget(size) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.name = `Nona.lum${size}`;
  return rt;
}

/**
 * Deterministic GPU auto-exposure.
 *
 * Downsamples log-luminance 64 -> 16 -> 4 -> 1, then runs an exponential moving
 * average in a 1x1 ping-pong target. Everything is driven by the engine's fixed
 * dt (never wall clock) so stepped frames reproduce exactly, adaptation rates
 * are asymmetric and slow, and the result is clamped hard so the image can
 * never pump or bloom out on a torch flicker.
 */
export class AutoExposurePass extends Pass {
  constructor(params) {
    super();
    this.params = params;
    this.needsSwap = false;
    this.enabled = true;

    this._q = new QuadRenderer();
    this.rt64 = lumTarget(64);
    this.rt16 = lumTarget(16);
    this.rt4 = lumTarget(4);
    this.rt1 = lumTarget(1);
    this.adapt = [lumTarget(1), lumTarget(1)];
    this._cur = 0;
    this._seeded = false;

    this.lumMaterial = quadMaterial('Nona.Lum', LUM_FRAG, {
      tHDR: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1920, 1 / 1080) },
    });
    this.downMaterial = quadMaterial('Nona.LumDown', DOWN_FRAG, {
      tSrc: { value: null },
      uSrcTexel: { value: new THREE.Vector2(1 / 64, 1 / 64) },
    });
    this.adaptMaterial = quadMaterial('Nona.LumAdapt', ADAPT_FRAG, {
      tLum: { value: this.rt1.texture },
      tPrev: { value: null },
      uDt: { value: 1 / 60 },
      uUpRate: { value: 1.6 },
      uDownRate: { value: 0.9 },
      uSeed: { value: 1 },
    });
  }

  /** Texture holding the adapted log2 luminance (1x1). */
  get adaptTexture() {
    return this.adapt[this._cur].texture;
  }

  /** Force the next measurement to be taken instantly (scenario switches). */
  reset() {
    this._seeded = false;
  }

  setSize(width, height) {
    this.lumMaterial.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const p = this.params;
    const q = this._q;

    this.lumMaterial.uniforms.tHDR.value = readBuffer.texture;
    q.render(renderer, this.lumMaterial, this.rt64);

    const du = this.downMaterial.uniforms;
    du.tSrc.value = this.rt64.texture;
    du.uSrcTexel.value.set(1 / 64, 1 / 64);
    q.render(renderer, this.downMaterial, this.rt16);

    du.tSrc.value = this.rt16.texture;
    du.uSrcTexel.value.set(1 / 16, 1 / 16);
    q.render(renderer, this.downMaterial, this.rt4);

    du.tSrc.value = this.rt4.texture;
    du.uSrcTexel.value.set(1 / 4, 1 / 4);
    q.render(renderer, this.downMaterial, this.rt1);

    const prev = this.adapt[this._cur];
    const next = this.adapt[1 - this._cur];
    const au = this.adaptMaterial.uniforms;
    au.tLum.value = this.rt1.texture;
    au.tPrev.value = prev.texture;
    au.uDt.value = Number.isFinite(deltaTime) ? Math.min(Math.max(deltaTime, 0), 0.25) : 1 / 60;
    au.uUpRate.value = p.exposureUpRate;
    au.uDownRate.value = p.exposureDownRate;
    au.uSeed.value = this._seeded ? 0 : 1;
    q.render(renderer, this.adaptMaterial, next);

    this._cur = 1 - this._cur;
    this._seeded = true;
  }

  dispose() {
    this.rt64.dispose();
    this.rt16.dispose();
    this.rt4.dispose();
    this.rt1.dispose();
    this.adapt[0].dispose();
    this.adapt[1].dispose();
    this.lumMaterial.dispose();
    this.downMaterial.dispose();
    this.adaptMaterial.dispose();
    this._q.dispose();
  }
}

/** Applies the adapted exposure gain to the HDR buffer, before bloom. */
export class ExposureApplyPass extends QuadPass {
  constructor(autoExposure, params, renderer) {
    super(
      APPLY_FRAG,
      {
        tDiffuse: { value: null },
        tAdapt: { value: null },
        uKey: { value: 0.16 },
        uMinGain: { value: 0.55 },
        uMaxGain: { value: 1.9 },
        uStrength: { value: 0.55 },
        uBias: { value: 1.0 },
      },
      {},
      'Nona.ExposureApply'
    );
    this.auto = autoExposure;
    this.params = params;
    this.renderer = renderer;
    this.needsSwap = true;
  }

  beforeRender() {
    const p = this.params;
    this.uniforms.tAdapt.value = this.auto.adaptTexture;
    this.uniforms.uKey.value = p.exposureKey;
    this.uniforms.uMinGain.value = p.exposureMinGain;
    this.uniforms.uMaxGain.value = p.exposureMaxGain;
    this.uniforms.uStrength.value = p.autoExposure;
    this.uniforms.uBias.value = this.renderer.toneMappingExposure || 1.0;
  }
}
