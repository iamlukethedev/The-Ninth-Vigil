import * as THREE from 'three';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { QuadRenderer, quadMaterial } from './QuadPass.js';
import { GLSL_COMMON, GLSL_BILATERAL } from './ShaderChunks.js';

const MARCH_FRAG = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tNormal;

uniform mat4  uProj;
uniform mat4  uInvProj;
uniform mat4  uCamWorld;
uniform float uNear;
uniform float uFar;

uniform float uIntensity;
uniform float uWetness;
uniform float uThickness;
uniform float uMaxDist;
uniform float uPuddleScale;
uniform float uPuddleContrast;
uniform float uFresnelBase;
uniform float uUpLo;
uniform float uUpHi;
uniform float uGloss;
uniform vec2  uGTexel;

varying vec2 vUv;

void main() {

  float dRaw = texture2D( tDepth, vUv ).x;
  if ( dRaw >= 0.999999 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 P = viewPosFromDepth( vUv, dRaw, uInvProj );
  vec3 N = normalize( texture2D( tNormal, vUv ).xyz * 2.0 - 1.0 );
  vec3 V = normalize( P );

  // World-space orientation decides what is "wet floor / polished slab".
  vec3 wN = normalize( ( uCamWorld * vec4( N, 0.0 ) ).xyz );
  float upMask = smoothstep( uUpLo, uUpHi, wN.y );
  if ( upMask <= 0.001 ) { gl_FragColor = vec4( 0.0 ); return; }

  // Puddles / polish break-up so the sheen is never a uniform mirror slab.
  vec3 wp = ( uCamWorld * vec4( P, 1.0 ) ).xyz;
  float pud = vnoise( wp.xz * uPuddleScale ) * 0.65 + vnoise( wp.xz * uPuddleScale * 2.7 + 11.3 ) * 0.35;
  pud = sat( ( pud - 0.5 ) * uPuddleContrast + 0.55 );

  // Roughness proxy: how much the normal wobbles in a small neighbourhood.
  // Bumpy stone scatters the reflection away; flat slabs keep it.
  vec3 n0 = normalize( texture2D( tNormal, vUv + vec2( uGTexel.x, 0.0 ) * 2.0 ).xyz * 2.0 - 1.0 );
  vec3 n1 = normalize( texture2D( tNormal, vUv - vec2( uGTexel.x, 0.0 ) * 2.0 ).xyz * 2.0 - 1.0 );
  vec3 n2 = normalize( texture2D( tNormal, vUv + vec2( 0.0, uGTexel.y ) * 2.0 ).xyz * 2.0 - 1.0 );
  vec3 n3 = normalize( texture2D( tNormal, vUv - vec2( 0.0, uGTexel.y ) * 2.0 ).xyz * 2.0 - 1.0 );
  float coherence = 0.25 * ( dot( N, n0 ) + dot( N, n1 ) + dot( N, n2 ) + dot( N, n3 ) );
  float smoothness = smoothstep( 0.965, 0.9995, coherence );

  float mask = upMask * pud * smoothness * uWetness;
  if ( mask <= 0.004 ) { gl_FragColor = vec4( 0.0 ); return; }

  vec3 R = normalize( reflect( V, N ) );
  float fres = uFresnelBase + ( 1.0 - uFresnelBase ) * pow( 1.0 - sat( dot( -V, N ) ), 5.0 );

  float jitter = ign( gl_FragCoord.xy );
  float stepLen = uMaxDist / float( SSR_STEPS ) * 0.8;
  float t = stepLen * ( 0.4 + jitter * 0.7 );
  float tPrev = 0.0;
  float tHit = 0.0;
  vec2 hitUV = vec2( 0.0 );
  float hit = 0.0;

  for ( int i = 0; i < SSR_STEPS; i ++ ) {
    vec3 p = P + R * t;
    if ( p.z > -uNear ) break;
    vec4 clip = uProj * vec4( p, 1.0 );
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) break;

    float sd = texture2D( tDepth, uv ).x;
    if ( sd < 0.999999 ) {
      float sceneZ = linearDist( sd, uNear, uFar );
      float delta = -p.z - sceneZ;
      // A hit only counts inside a thin shell in front of the sampled surface.
      // Anything deeper is geometry the ray passed behind — rejecting it is what
      // stops the classic SSR smear trail.
      float thick = uThickness * ( 1.0 + sceneZ * 0.05 );
      if ( delta > 0.0 && delta < thick ) { hit = 1.0; hitUV = uv; tHit = t; break; }
    }
    tPrev = t;
    t += stepLen;
    stepLen *= 1.17;
  }

  if ( hit < 0.5 ) { gl_FragColor = vec4( 0.0 ); return; }

  // Binary refine so the contact point lands on the silhouette, not a step edge.
  float a = tPrev;
  float b = tHit;
  for ( int k = 0; k < 4; k ++ ) {
    float m = ( a + b ) * 0.5;
    vec3 pm = P + R * m;
    vec4 cm = uProj * vec4( pm, 1.0 );
    vec2 um = cm.xy / cm.w * 0.5 + 0.5;
    float sz = linearDist( texture2D( tDepth, um ).x, uNear, uFar );
    if ( -pm.z > sz ) { b = m; hitUV = um; tHit = m; } else { a = m; }
  }

  // Slight gather so the reflection reads as damp stone, not a chrome mirror.
  float blur = min( 0.006, tHit * 0.0009 ) * ( 1.0 - uGloss );
  float ang = jitter * 6.2831853;
  vec2 o1 = vec2( cos( ang ), sin( ang ) ) * blur;
  vec2 o2 = vec2( -o1.y, o1.x ) * 0.8;
  vec3 col = texture2D( tColor, hitUV ).rgb * 0.5
           + texture2D( tColor, clamp( hitUV + o1, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb * 0.25
           + texture2D( tColor, clamp( hitUV - o2, vec2( 0.0 ), vec2( 1.0 ) ) ).rgb * 0.25;

  float edge = smoothstep( 0.0, 0.13, hitUV.x ) * smoothstep( 1.0, 0.87, hitUV.x )
             * smoothstep( 0.0, 0.09, hitUV.y ) * smoothstep( 1.0, 0.91, hitUV.y );
  float distFade = 1.0 - sat( tHit / uMaxDist );
  distFade *= distFade;
  float backFade = sat( 0.9 - R.z * 0.55 );

  float w = sat( mask * fres * edge * distFade * backFade * uIntensity );
  gl_FragColor = vec4( min( col, vec3( 12.0 ) ), w );
}
`;

const COMPOSITE_FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_BILATERAL}

uniform sampler2D tDiffuse;
uniform sampler2D tRefl;
uniform sampler2D tDepth;
uniform vec2  uReflTexel;
uniform float uNear;
uniform float uFar;
uniform float uDepthSigma;

varying vec2 vUv;

void main() {
  vec4 base = texture2D( tDiffuse, vUv );
  float dRaw = texture2D( tDepth, vUv ).x;
  if ( dRaw >= 0.999999 ) { gl_FragColor = base; return; }

  float centerDist = linearDist( dRaw, uNear, uFar );
  vec4 r = bilateralUpsample( tRefl, tDepth, vUv, uReflTexel, centerDist, uDepthSigma, uNear, uFar );

  // Blend, never add: additive reflections wash the floor into milk.
  gl_FragColor = vec4( mix( base.rgb, r.rgb, sat( r.a ) ), base.a );
}
`;

/**
 * Screen-space reflections for wet floor and polished stone.
 *
 * Half-resolution ray march against the shared G-buffer, refined with a binary
 * search, rejected outside a thin depth shell (no smear), faded at screen
 * borders, on rough/bumpy normals and with march distance. Composited back with
 * a depth-aware bilateral upsample.
 */
export class ReflectionPass extends Pass {
  constructor({ camera, depthTexture, normalTexture, params, steps = 20 }) {
    super();
    this.camera = camera;
    this.params = params;
    this.needsSwap = true;
    this._renderer = new QuadRenderer();

    this.target = new THREE.WebGLRenderTarget(2, 2, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'Nona.ssr';

    this.marchMaterial = quadMaterial(
      'Nona.SSRMarch',
      MARCH_FRAG,
      {
        tColor: { value: null },
        tDepth: { value: depthTexture },
        tNormal: { value: normalTexture },
        uProj: { value: new THREE.Matrix4() },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uIntensity: { value: 0.6 },
        uWetness: { value: 0.7 },
        uThickness: { value: 0.55 },
        uMaxDist: { value: 26.0 },
        uPuddleScale: { value: 0.11 },
        uPuddleContrast: { value: 1.9 },
        uFresnelBase: { value: 0.075 },
        uUpLo: { value: 0.72 },
        uUpHi: { value: 0.965 },
        uGloss: { value: 0.55 },
        uGTexel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
      },
      { SSR_STEPS: steps }
    );

    this.compositeMaterial = quadMaterial('Nona.SSRComposite', COMPOSITE_FRAG, {
      tDiffuse: { value: null },
      tRefl: { value: this.target.texture },
      tDepth: { value: depthTexture },
      uReflTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
      uNear: { value: camera.near },
      uFar: { value: camera.far },
      uDepthSigma: { value: 5.0 },
    });

    this.scale = 0.5;
  }

  setGBuffer(depthTexture, normalTexture, gw, gh) {
    this.marchMaterial.uniforms.tDepth.value = depthTexture;
    this.marchMaterial.uniforms.tNormal.value = normalTexture;
    this.compositeMaterial.uniforms.tDepth.value = depthTexture;
    this.marchMaterial.uniforms.uGTexel.value.set(1 / Math.max(1, gw), 1 / Math.max(1, gh));
  }

  setSize(width, height) {
    const w = Math.max(4, Math.round(width * this.scale));
    const h = Math.max(4, Math.round(height * this.scale));
    this.target.setSize(w, h);
    this.compositeMaterial.uniforms.uReflTexel.value.set(1 / w, 1 / h);
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    const p = this.params;
    const mu = this.marchMaterial.uniforms;

    mu.tColor.value = readBuffer.texture;
    mu.uProj.value.copy(cam.projectionMatrix);
    mu.uInvProj.value.copy(cam.projectionMatrixInverse);
    mu.uCamWorld.value.copy(cam.matrixWorld);
    mu.uNear.value = cam.near;
    mu.uFar.value = cam.far;
    mu.uIntensity.value = p.ssrIntensity;
    mu.uWetness.value = p.ssrWetness;
    mu.uThickness.value = p.ssrThickness;
    mu.uMaxDist.value = p.ssrMaxDistance;
    mu.uPuddleScale.value = p.ssrPuddleScale;
    mu.uGloss.value = p.ssrGloss;
    mu.uFresnelBase.value = p.ssrFresnelBase;

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.uNear.value = cam.near;
    this.compositeMaterial.uniforms.uFar.value = cam.far;

    this._renderer.render(renderer, this.marchMaterial, this.target);
    this._renderer.render(renderer, this.compositeMaterial, this.renderToScreen ? null : writeBuffer);
  }

  dispose() {
    this.target.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this._renderer.dispose();
  }
}
