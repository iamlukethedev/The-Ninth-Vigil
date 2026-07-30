/**
 * THE NINTH VIGIL — the stain decal material.
 *
 * A MeshStandardMaterial extended through onBeforeCompile so decals are properly
 * lit, shadowed and fogged like any other surface — an unlit decal reads as a
 * sticker and is an instant critic fail.
 *
 * TEXTURE UNIT BUDGET: this material binds exactly TWO textures.
 *   map        RGB albedo, A coverage
 *   normalMap  RG normal.xy (z reconstructed via USE_PACKED_NORMALMAP),
 *              B relative roughness, A detail mask
 * Roughness, occlusion and the emissive mask are all channel-routed out of the
 * normal map, so we never allocate roughnessMap/metalnessMap/aoMap/emissiveMap
 * units. Worst case with 4 CSM cascades + 2 shadowed point lights + env = 9/16.
 *
 * Everything time-varying (drying, cooling embers, fading, spreading pools,
 * pulsing runes) is evaluated in the shader from per-vertex birth stamps and one
 * `uTime` uniform, so ageing 240 decals costs zero CPU per frame.
 */
import * as THREE from 'three';

const DECL_V = /* glsl */`
attribute vec4 aTint;
attribute vec4 aEmis;
attribute vec4 aTiming;
attribute vec4 aFlags;
attribute vec2 aLocal;
varying vec4 vDTint;
varying vec4 vDEmis;
varying vec4 vDTiming;
varying vec4 vDFlags;
varying vec2 vDLocal;
`;

const DECL_F = /* glsl */`
uniform float uTime;
varying vec4 vDTint;
varying vec4 vDEmis;
varying vec4 vDTiming;
varying vec4 vDFlags;
varying vec2 vDLocal;
`;

/** age / dry / grow / fade, all derived from the birth stamp. */
const AGE_BLOCK = /* glsl */`
  float dAge   = max( 0.0, uTime - vDTiming.x );
  float dLife  = max( 0.05, vDTiming.y );
  float dFadeI = max( 0.0001, vDTiming.z );
  float dDryT  = max( 0.0001, vDTiming.w );
  float dCls   = vDFlags.x;
  float dGrowT = vDFlags.y;
  float dPhase = fract( vDTiming.x * 0.61803399 ) * 6.2831853;

  float dDry = clamp( dAge / dDryT, 0.0, 1.0 );
  dDry = dDry * dDry * ( 3.0 - 2.0 * dDry );

  float dIn  = clamp( dAge / dFadeI, 0.0, 1.0 );
  dIn = dIn * dIn * ( 3.0 - 2.0 * dIn );
  float dOut = 1.0 - smoothstep( dLife * 0.62, dLife, dAge );
  float dAlpha = dIn * dOut * vDTint.w;

  float dGrow = dGrowT > 0.0 ? clamp( dAge / dGrowT, 0.0, 1.0 ) : 1.0;
  dGrow = dGrow * dGrow * ( 3.0 - 2.0 * dGrow );
`;

/**
 * @param {import('../../core/Engine.js').Engine} engine
 * @param {{map:THREE.Texture, packed:THREE.Texture}} atlas
 */
export function makeStainMaterial(engine, atlas) {
  const mat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    normalMap: atlas.packed,
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    // depth bias so a decal 2 cm above the flagstones can never z-fight it
    polygonOffset: true,
    polygonOffsetFactor: -3.0,
    polygonOffsetUnits: -6.0,
    envMapIntensity: 0.7,
    dithering: true,
    emissive: 0x000000,
    emissiveIntensity: 1.0,
    forceSinglePass: true,
  });
  mat.name = 'NonaDecalStain';
  mat.normalMapType = THREE.TangentSpaceNormalMap;
  mat.normalScale.set(1.25, 1.25);
  // three only sets this when the texture is a 2-channel format; ours is RGBA
  // because B and A carry roughness + mask, so we declare it by hand.
  mat.defines = { ...(mat.defines ?? {}), USE_PACKED_NORMALMAP: '' };

  const uTime = { value: 0 };
  mat.userData.uTime = uTime;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${DECL_V}`)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vDTint = aTint;
        vDEmis = aEmis;
        vDTiming = aTiming;
        vDFlags = aFlags;
        vDLocal = aLocal;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${DECL_F}`)
      .replace('#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>\n${AGE_BLOCK}`)

      /* ---- coverage: growth threshold + lifetime fade ---- */
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        float dCov = sampledDiffuseColor.a;
        float dThr = ( 1.0 - dGrow ) * 0.98 - 0.13;
        float dGate = smoothstep( dThr, dThr + 0.12, dCov );
        diffuseColor.a = dCov * dGate * dAlpha;
        if ( diffuseColor.a < 0.0045 ) discard;
        vec4 dPack = texture2D( normalMap, vNormalMapUv );
        float dMask = dPack.a;

        diffuseColor.rgb *= vDTint.rgb;

        // blood: coagulates — desaturates toward dark oxidised brown as it dries
        if ( dCls < 0.5 ) {
          float lum = dot( diffuseColor.rgb, vec3( 0.32, 0.55, 0.13 ) );
          vec3 oxid = lum * vec3( 1.30, 0.66, 0.52 ) * 0.62;
          diffuseColor.rgb = mix( diffuseColor.rgb, oxid, dDry * 0.88 );
          // the still-wet centre keeps a darker, deeper value
          diffuseColor.rgb *= mix( 0.88, 1.0, dDry ) + dMask * ( 1.0 - dDry ) * 0.10;
        } else if ( dCls < 1.5 ) {
          // scorch: ash pales as it cools, char stays black
          diffuseColor.rgb *= 1.0 + dDry * 0.22 * ( 1.0 - dMask );
        } else if ( dCls < 2.5 ) {
          // rime: sublimates — loses body before it loses coverage
          diffuseColor.rgb *= 1.0 - dDry * 0.30;
        } else if ( dCls < 3.5 ) {
          // crack: dust settles out of the halo, grooves stay dark
          diffuseColor.rgb *= 1.0 - dDry * 0.16 * ( 1.0 - dMask );
        } else if ( dCls > 5.5 ) {
          /* rune: a sigil is CARVED, so the flagstone under it must still read.
             Coverage is ceilinged and ramped down toward the sigil's rim, which
             is what stops a ward reading as a decal sticker pasted over the
             floor — the joints and grain of the stone stay visible through it. */
          vec2 rq = vDLocal * 2.0 - 1.0;
          float rEdge = 1.0 - smoothstep( 0.72, 1.02, length( rq ) );
          diffuseColor.a = min( diffuseColor.a * ( 0.34 + 0.66 * rEdge ), 0.78 );
        }
      `)

      /* ---- roughness out of packed.b, wet->dry over the ageing curve ---- */
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = mix( vDFlags.z, vDFlags.w, dDry ) * ( 0.62 + 0.78 * dPack.b );
        roughnessFactor = clamp( roughnessFactor, 0.045, 1.0 );
      `)

      /* ---- emissive: cooling embers, frost rim, pulsing sigils ---- */
      .replace('#include <emissivemap_fragment>', /* glsl */`
        vec3 dEmissive = vec3( 0.0 );
        float dGain = vDEmis.w;
        /* Unit-luminance form of the emissive tint. Every ceiling below is then a
           display LUMINANCE and behaves the same for a saturated hellfire orange
           as for a pale frost blue — and, critically, the ceilings can sit above
           the authored peak as a safety rail instead of acting as a limiter. A
           limiter flattens everything past it onto one value, which erases the
           erosion / flow structure and puts flat 1-bit line art straight back. */
        vec3 dTintN = vDEmis.rgb
          / max( dot( vDEmis.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
        if ( dGain > 0.0 ) {
          if ( dCls < 1.5 && dCls > 0.5 ) {
            // ember: a bright flash that cools to a deep red glow in the cracks
            float hot  = exp( -dAge / 0.85 );
            float tail = exp( -dAge / 3.6 );
            float flick = 0.72 + 0.28 * sin( uTime * 8.3 + dPhase + vDLocal.x * 11.0 );
            vec3 hotCol = mix( dTintN, vec3( 1.0, 0.80, 0.42 ), hot * 0.55 );
            /* 0.030 x gain: with the type's 2.3 gain that is a ~0.069 luminance
               peak on the very freshest ember, decaying from there. */
            vec3 em = dMask * dMask * dGain * 0.030 * flick *
              ( hotCol * hot * 0.85 + dTintN * vec3( 1.0, 0.42, 0.14 ) * tail * 0.40 );
            /* CEILING — see the note on the rune branch for the derivation.
               A 2.3 gain on a mask that saturated across every worley cell wall
               resolved as (2.9, 1.7, 0.8) HDR, i.e. all three channels railed:
               the ember network came out as a blown WHITE HEX MESH lying on the
               moor. Fire is allowed to be the brightest thing on the ground, so
               its ceiling is above a rune's — but the BLUE channel has to stay
               down or "hot" resolves as white instead of as hot. */
            float bLum = dot( em, vec3( 0.2126, 0.7152, 0.0722 ) );
            float bMax = max( em.r, max( em.g, em.b ) );
            em *= min( 1.0, min( 0.090 / max( bLum, 1e-4 ), 0.155 / max( bMax, 1e-4 ) ) );
            dEmissive = em;
          } else if ( dCls < 2.5 ) {
            // rime: cold rim light that dies with the frost
            float shimmer = 0.68 + 0.32 * sin( uTime * 3.1 + dPhase + vDLocal.y * 9.0 );
            // Same scale logic as the ember, one stop lower: frost catches light,
            // it does not emit it. 0.075 x the type's 0.48 gain ~= 0.036 peak.
            vec3 em = dMask * dMask * dGain * 0.075 * ( 1.0 - dDry * 0.85 ) * shimmer * dTintN;
            float iLum = dot( em, vec3( 0.2126, 0.7152, 0.0722 ) );
            float iMax = max( em.r, max( em.g, em.b ) );
            em *= min( 1.0, min( 0.055 / max( iLum, 1e-4 ), 0.095 / max( iMax, 1e-4 ) ) );
            dEmissive = em;
          } else if ( dCls > 5.5 ) {
            /* rune: light travelling through an engraved channel.
             *
             * dMask now carries the channel's cross-section (dark in the
             * groove, bright at the lip) plus its erosion and charge fields, so
             * squaring it concentrates the emission into the lip and kills the
             * mid-tones — the read becomes "a rim of light" instead of "a lit
             * line". Three coupled modulators travel across it:
             *   flow    a scrolling field along the channel,
             *   sweep   one slow revolution of charge,
             *   breath  the whole sigil inhaling.
             * and a radial ramp so the outer strokes are cooler than the heart
             * and the sigil does not end at a hard bright circle.
             */
            vec2 rp = vDLocal * 2.0 - 1.0;
            float rr = length( rp );
            float ang = atan( rp.y, rp.x );
            float flow = 0.5 + 0.5 * sin( ang * 3.0 + rr * 9.0 - uTime * 0.72 + dPhase );
            float sweep = 0.55 + 0.45 * sin( ang * 2.0 - uTime * 0.85 + dPhase );
            float breath = 0.68 + 0.32 * sin( uTime * 1.15 + dPhase );
            float ramp = 0.34 + 0.66 * ( 1.0 - smoothstep( 0.30, 1.00, rr ) );
            /* 0.085 x gain: with the types' 0.54-0.66 gains that is a 0.046-0.056
               luminance peak, reached only where the mask, the sweep and the flow
               all align. Everything below it keeps its structure because the
               ceiling further down is a rail, not a limiter. */
            vec3 em = dMask * dMask * dGain * 0.085 * breath * ramp
                    * ( 0.48 + 0.52 * sweep ) * ( 0.52 + 0.60 * flow ) * dTintN;
            /* LUMA ceiling, not a per-channel clamp, and MEASURED against the
               post chain rather than picked by eye. Clamping channels is what
               turned a saturated orange ward into a pale cream ring: R hit the
               rail, G kept climbing, the hue died. And the old 0.85 was in scene
               units — the grade pass lifts midtones ~3x (crypt: blackPoint 0.028,
               whitePoint 0.72, contrast 1.38 about pivot 0.44), so 0.85 HDR luma
               through exposure -> ACES -> sRGB -> grade resolves at 253/255. A
               ground sigil at 0.058 lands near 155/255: still unmistakably lit
               stone-magic, no longer the brightest thing in the frame.
               The max-channel rail keeps a saturated hue from clipping R alone,
               which is what the grade's highlight desaturation reads as white. */
            float eLum = dot( em, vec3( 0.2126, 0.7152, 0.0722 ) );
            float eMax = max( em.r, max( em.g, em.b ) );
            em *= min( 1.0, min( 0.075 / max( eLum, 1e-4 ), 0.130 / max( eMax, 1e-4 ) ) );
            dEmissive = em;
          } else {
            vec3 em = dMask * dGain * 0.065 * dTintN;
            float oLum = dot( em, vec3( 0.2126, 0.7152, 0.0722 ) );
            em *= min( 1.0, 0.060 / max( oLum, 1e-4 ) );
            dEmissive = em;
          }
        }
        totalEmissiveRadiance = dEmissive * dAlpha;
      `);
  };

  // Height fog / aerial perspective, so a distant stain never pops out of the mist.
  try { engine.get('sky')?.applyFog?.(mat); } catch { /* optional */ }

  return mat;
}
