import { QuadPass } from './QuadPass.js';
import { GLSL_COMMON, GLSL_GRADE, GLSL_GRAIN, GLSL_CAVIGNETTE } from './ShaderChunks.js';
import { gradeUniforms, syncGradeUniforms } from './GradePass.js';
import { grainUniforms, syncGrainUniforms } from './GrainPass.js';
import { caVignetteUniforms, syncCaVignetteUniforms } from './CAVignettePass.js';

const FRAG = /* glsl */ `
${GLSL_COMMON}
${GLSL_GRADE}
${GLSL_GRAIN}
${GLSL_CAVIGNETTE}

uniform sampler2D tDiffuse;
uniform float uCaClamp;
uniform float uGrainChromaFloor;
uniform float uGrainChromaKnee0;
uniform float uGrainChromaKnee1;
varying vec2 vUv;

void main() {
  // CA, deviation-clamped exactly as CAVignettePass does it — see the note on
  // CA_DEVIATION_CLAMP there for why an unclamped per-channel shift turns this
  // pass into an amplifier for the frame's own aliasing.
  vec3 ref = texture2D( tDiffuse, vUv ).rgb;
  vec3 c = nonaChroma( tDiffuse, vUv );
  vec3 lim = vec3( uCaClamp );
  c = ref + clamp( c - ref, -lim, lim );

  c = nonaGrade( c );

  // Grain, with the chroma component faded out of the deep shadows exactly as
  // GrainPass does it — see GRAIN_CHROMA_SHADOW_FLOOR there.
  vec3 g = nonaGrain( c, gl_FragCoord.xy );
  vec3 d = g - c;
  float mono = ( d.r + d.g + d.b ) * 0.3333;
  float keep = mix(
    uGrainChromaFloor, 1.0,
    smoothstep( uGrainChromaKnee0, uGrainChromaKnee1, luma( c ) ) );
  c += mix( vec3( mono ), d, keep );

  c *= nonaVignette( vUv );
  gl_FragColor = vec4( max( c, vec3( 0.0 ) ), 1.0 );
}
`;

/**
 * Single-pass finish: chromatic aberration -> grade -> grain -> vignette.
 *
 * Pixel-identical intent to running GradePass + GrainPass + CAVignettePass back
 * to back, but with one draw and one set of bandwidth. Used on the low and
 * medium tiers where three extra full-resolution passes are not affordable.
 * The CA deviation clamp and the shadow chroma gate on the grain are duplicated
 * inline here so the cheap tiers get the same discipline as the expensive ones —
 * if you change either one, change it in both places.
 */
export class CompositePass extends QuadPass {
  constructor(params, lutCache) {
    super(
      FRAG,
      {
        tDiffuse: { value: null },
        ...gradeUniforms(),
        ...grainUniforms(),
        ...caVignetteUniforms(),
      },
      {},
      'Nona.Composite'
    );
    this.params = params;
    this.lutCache = lutCache;
    this.frame = 0;
    this.needsSwap = true;
  }

  beforeRender() {
    syncGradeUniforms(this.uniforms, this.params, this.lutCache);
    syncGrainUniforms(this.uniforms, this.params, this.frame);
    syncCaVignetteUniforms(this.uniforms, this.params);
  }
}
