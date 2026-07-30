import * as THREE from 'three';

/**
 * View-space normal + hardware depth prepass.
 *
 * One cheap geometry pass feeds GTAO, screen-space reflections, the volumetric
 * shafts, camera motion blur and DOF — which is far cheaper than letting each
 * addon pass re-render the scene for its own G-buffer (GTAOPass, SSRPass and
 * BokehPass each want one).
 *
 * Anything that would not write depth in the beauty pass (transparent VFX,
 * sprites, points, the sky dome) is skipped so the depth buffer only ever
 * contains solid geometry.
 *
 * WHAT COUNTS AS SOLID — and why `material.transparent` is the wrong test.
 * ----------------------------------------------------------------------
 * The rule this pass must enforce is "everything the beauty pass writes depth
 * for, and nothing else", because every consumer (contact AO above all) asks the
 * buffer "what geometry is here". `transparent === true` is NOT that rule, and
 * using it dropped real occluders on the floor:
 *
 *   • `AssetForge.material()` turns on `transparent` + `alphaTest 0.05` for every
 *     albedo that carries an alpha channel, so all alpha-cut foliage arrives
 *     transparent-but-depth-writing. Measured on `hub` and `overworld`, the four
 *     `props.deadTree#N#1` moss canopies were absent from depth, i.e. no contact
 *     occlusion and no AO anywhere under a tree, plus SSR/DOF holes in its
 *     silhouette.
 *   • A multi-material mesh was judged by `material[0]` ALONE. The wraith
 *     (`[wraith:shroud, wraith:bone, wraith:smoke]`) leads with its transparent
 *     shroud, so an entire 2 m CHARACTER was missing from the prepass — nothing
 *     under its feet could ever be occluded by it.
 *
 * So: `depthWrite` decides (it is what three actually obeys), a transparent
 * material additionally has to be a plain NormalBlending / alpha-tested layer
 * before it may become an occluder — an additive flame or a multiplicative
 * contact blob must never write depth even if it forgot to say so — and an array
 * material counts as solid when ANY of its slots does. `userData.noGBuffer`
 * stays an explicit opt-out and `userData.forceGBuffer` an explicit opt-in.
 */
export class GBuffer {
  constructor(scene, camera, width, height) {
    this.scene = scene;
    this.camera = camera;
    this.width = Math.max(2, width | 0);
    this.height = Math.max(2, height | 0);

    this.depthTexture = new THREE.DepthTexture(this.width, this.height);
    this.depthTexture.format = THREE.DepthFormat;
    this.depthTexture.type = THREE.UnsignedIntType;
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.depthTexture.generateMipmaps = false;
    this.depthTexture.name = 'Nona.gbufferDepth';

    this.target = new THREE.WebGLRenderTarget(this.width, this.height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      depthTexture: this.depthTexture,
    });
    this.target.texture.name = 'Nona.gbufferNormal';

    this.material = new THREE.MeshNormalMaterial();
    this.material.blending = THREE.NoBlending;
    this.material.side = THREE.FrontSide;
    this.material.onBeforeCompile = GBuffer._guardNormals;

    this._hidden = [];
    this._clearColor = new THREE.Color();
    this._skipColor = new THREE.Color(0x8080ff);
  }

  get normalTexture() {
    return this.target.texture;
  }

  setSize(width, height) {
    const w = Math.max(2, width | 0);
    const h = Math.max(2, height | 0);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.setSize(w, h);
  }

  /**
   * NO NON-FINITE NORMAL MAY LEAVE THIS PASS.
   *
   * Symptom: hard-edged black wedges flashing across the frame while playing,
   * reshaping completely between consecutive frames even with the camera still.
   * They are not a lighting bug. Measured with every pass after `aoApply`
   * disabled, ~22 % of this buffer was NaN, and the affected area churned frame
   * to frame; in the real pipeline `aoApply` on vs off changed the frame's
   * dark-area thrash by 190x (0.0580 -> 0.0003), identical idle and walking.
   *
   * Where the NaN comes from. Vertex data, instance matrices and world matrices
   * are all finite — it is generated in the vertex shader. three's
   * `<defaultnormal_vertex>` normalises an instanced normal by dividing by the
   * squared length of each instance-matrix column:
   *
   *     transformedNormal /= vec3( dot( m[0], m[0] ), dot( m[1], m[1] ), ... );
   *
   * A fully collapsed instance (zero scale, which the dungeon uses to retire a
   * slot without shrinking `count`) makes every one of those dots zero, so the
   * division yields Inf and the following `m * transformedNormal` yields
   * 0 * Inf = NaN. The beauty pass never showed it because nothing there
   * normalises the result into a consumer that then integrates over a
   * neighbourhood; AO does exactly that, so one NaN texel poisons every sample
   * that reaches it and the occlusion collapses over a wide area.
   *
   * The guard is written as a rejection rather than an `isnan()` test so it
   * catches Inf as well, and so it does not depend on GLSL version: a NaN fails
   * every comparison, so `!(L2 > lo && L2 < hi)` is true for NaN, Inf and zero
   * alike. View-space +Z is the correct fallback — it is what the pass already
   * substitutes for pixels with no geometry.
   */
  static _guardNormals(shader) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <defaultnormal_vertex>',
      [
        '#include <defaultnormal_vertex>',
        '{',
        '  float nonaNL2 = dot( transformedNormal, transformedNormal );',
        '  if ( ! ( nonaNL2 > 1.0e-16 && nonaNL2 < 1.0e30 ) ) {',
        '    transformedNormal = vec3( 0.0, 0.0, 1.0 );',
        '  }',
        '}',
      ].join('\n')
    );
  }

  /**
   * True when this single material writes depth in the beauty pass — see the
   * class note. Opaque: always. Transparent: only when it asked for depth AND it
   * is a plain coverage layer (NormalBlending, usually alpha-tested), never an
   * additive / subtractive / multiplicative effect.
   */
  static writesSolidDepth(m) {
    if (!m || m.visible === false) return false;
    if (m.depthWrite === false) return false;
    if (m.transparent !== true) return true;
    const b = m.blending;
    return b === undefined || b === THREE.NormalBlending;
  }

  /** Hide everything that must not contribute solid depth, remembering state. */
  _mask(root) {
    const hidden = this._hidden;
    hidden.length = 0;
    const solid = GBuffer.writesSolidDepth;
    root.traverse((o) => {
      if (o.visible !== true) return;
      let skip = false;
      if (o.isPoints === true || o.isLine === true || o.isSprite === true) {
        skip = true;
      } else if (o.isMesh === true) {
        const ud = o.userData;
        if (ud && ud.noGBuffer === true) {
          skip = true;
        } else if (ud && ud.forceGBuffer === true) {
          skip = false;
        } else {
          const m = o.material;
          if (Array.isArray(m)) {
            // A group of the mesh writing depth is enough: the shroud must not
            // take the skeleton's bones out of the buffer with it.
            skip = true;
            for (let i = 0; i < m.length; i++) {
              if (solid(m[i])) { skip = false; break; }
            }
          } else {
            skip = !solid(m);
          }
        }
      }
      if (skip) {
        o.visible = false;
        hidden.push(o);
      }
    });
  }

  _unmask() {
    const hidden = this._hidden;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
    hidden.length = 0;
  }

  render(renderer) {
    const scene = this.scene;
    const oldAutoClear = renderer.autoClear;
    const oldOverride = scene.overrideMaterial;
    const oldBackground = scene.background;
    const oldAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clearColor);

    /*
     * SHADOWS MUST NOT BE RENDERED FOR THIS PASS.
     *
     * `renderer.render()` unconditionally runs `shadowMap.render()` first, and
     * this prepass is the SECOND scene render of the frame — so every cascade
     * and every point-light cube face was being rasterised twice per frame.
     * Measured on `combat` at 1600x900: 2,050 draw calls and 12.9 M triangles,
     * i.e. 43 % of the frame's draw calls and 45 % of its triangles, thrown away
     * immediately because a normal/depth prepass samples no shadow map at all.
     *
     * Gating `autoUpdate`/`needsUpdate` makes `WebGLShadowMap.render()` return
     * at its first line. The beauty pass that follows re-enables them and builds
     * the maps exactly once, so the result is bit-identical.
     */
    const shadowMap = renderer.shadowMap;
    const oldShadowAuto = shadowMap.autoUpdate;
    const oldShadowNeeds = shadowMap.needsUpdate;

    try {
      this._mask(scene);
      scene.background = null;
      scene.overrideMaterial = this.material;
      shadowMap.autoUpdate = false;
      shadowMap.needsUpdate = false;

      renderer.autoClear = false;
      renderer.setRenderTarget(this.target);
      renderer.setClearColor(this._skipColor, 1.0);
      renderer.clear(true, true, false);
      renderer.render(scene, this.camera);
    } finally {
      // The scene must come back exactly as we found it even if the draw threw,
      // otherwise the beauty pass would render normals or hide half the world.
      shadowMap.autoUpdate = oldShadowAuto;
      shadowMap.needsUpdate = oldShadowNeeds;
      scene.overrideMaterial = oldOverride;
      scene.background = oldBackground;
      this._unmask();
      renderer.setClearColor(this._clearColor, oldAlpha);
      renderer.autoClear = oldAutoClear;
      renderer.setRenderTarget(null);
    }
  }

  dispose() {
    this.target.dispose();
    this.depthTexture.dispose();
    this.material.dispose();
    this._hidden.length = 0;
  }
}
