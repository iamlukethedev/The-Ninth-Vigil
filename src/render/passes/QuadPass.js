import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT } from './ShaderChunks.js';

/**
 * Minimal full-screen shader pass. Same contract as three's ShaderPass but it
 * owns its material outright, never allocates per frame, and exposes a
 * `beforeRender` hook so subclasses can push uniforms without re-implementing
 * the render plumbing.
 */
export class QuadPass extends Pass {
  /**
   * @param {string} fragmentShader
   * @param {Object} uniforms
   * @param {Object} [defines]
   * @param {string} [name]
   */
  constructor(fragmentShader, uniforms, defines = {}, name = 'QuadPass') {
    super();
    this.material = new THREE.ShaderMaterial({
      name,
      defines: { ...defines },
      uniforms,
      vertexShader: FS_VERT,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.uniforms = this.material.uniforms;
    this._quad = new FullScreenQuad(this.material);
    this.width = 1;
    this.height = 1;
  }

  /** Override in subclasses; called before the draw with the read buffer bound. */
  beforeRender(/* renderer, readBuffer, deltaTime */) {}

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    if (this.uniforms.tDiffuse) this.uniforms.tDiffuse.value = readBuffer.texture;
    this.beforeRender(renderer, readBuffer, deltaTime);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.width = width;
    this.height = height;
    if (this.uniforms.uResolution) this.uniforms.uResolution.value.set(width, height);
    if (this.uniforms.uTexel) this.uniforms.uTexel.value.set(1 / Math.max(1, width), 1 / Math.max(1, height));
    if (this.uniforms.uAspect) this.uniforms.uAspect.value = width / Math.max(1, height);
    this.onResize?.(width, height);
  }

  dispose() {
    this.material.dispose();
    // NOTE: FullScreenQuad.dispose() frees three's *shared* fullscreen triangle,
    // which every other pass still points at. Releasing the material is enough.
    this._quad.material = null;
  }
}

/** Renders `material` into `target` with a shared fullscreen triangle. */
export class QuadRenderer {
  constructor() {
    this._quad = new FullScreenQuad(null);
  }
  render(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target ?? null);
    this._quad.render(renderer);
  }
  dispose() {
    this._quad.material = null;
  }
}

/** Convenience: a plain full-screen ShaderMaterial with post-friendly state. */
export function quadMaterial(name, fragmentShader, uniforms, defines = {}) {
  return new THREE.ShaderMaterial({
    name,
    defines: { ...defines },
    uniforms,
    vertexShader: FS_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}
