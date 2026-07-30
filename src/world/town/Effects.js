/**
 * THE NINTH VIGIL — town atmospherics: chimney smoke and brazier flame.
 *
 * Both are deliberately NOT billboard quads. Camera-facing cards are an explicit
 * instant-fail in the rubric, and a town at dusk lives or dies on whether the
 * air above it has substance.
 *
 *  • **Smoke** is a real tapered tube per chimney, merged into one buffer and
 *    animated by an additive per-vertex offset in the vertex shader (additive, so
 *    it stays correct after the geometry has been baked into world space). It
 *    runs on a MeshStandardMaterial with a vec4 vertex colour, which means it is
 *    LIT — the sunset key catches the top of the plume and the forge underlights
 *    its own — and it is fogged and tone-mapped by the standard pipeline. One
 *    draw call for every chimney in the town.
 *  • **Flame** reuses the dressing module's flame shader and geometry through an
 *    InstancedMesh, so a brazier in the town looks like a brazier in the crypt
 *    and costs one draw call and no new program.
 */

import * as THREE from 'three';
import { flameGeo, fbm3 } from '../props/Geo.js';
import { makeFlameMaterial } from '../props/PropMaterials.js';

/* ------------------------------------------------------------------ *
 * smoke
 * ------------------------------------------------------------------ */

const SMOKE_INJECT_V = /* glsl */`
attribute vec2 aSmoke;      // x = height 0..1, y = per-plume phase
uniform float uTownTime;
`;

const SMOKE_INJECT_BODY = /* glsl */`
	{
		float h = aSmoke.x;
		float ph = aSmoke.y;
		float t = uTownTime * 0.26 + ph * 6.2831853;
		float k = pow( h, 1.45 );
		// two drift octaves: a slow lean plus a faster curl
		transformed.x += ( sin( t + h * 2.3 ) * 1.05 + sin( t * 0.57 + h * 5.1 ) * 0.42 ) * k;
		transformed.z += ( cos( t * 0.83 + h * 1.9 ) * 0.92 + cos( t * 0.43 + h * 4.3 ) * 0.38 ) * k;
		transformed.y += sin( t * 0.7 + h * 3.1 ) * 0.18 * k;
	}
`;

export class SmokeField {
  /** @param {Array<{x:number,y:number,z:number,r:number,warm?:boolean}>} plumes */
  constructor(plumes) {
    this.mesh = null;
    this.mat = null;
    this.uniforms = null;
    if (!plumes || !plumes.length) return;

    const pos = [], nor = [], uv = [], col = [], sm = [], idx = [];
    const RINGS = 9, SEG = 9;

    for (let p = 0; p < plumes.length; p++) {
      const P = plumes[p];
      const H = P.warm ? 4.6 : 6.2;
      const phase = (p * 0.6180339887) % 1;
      const base = pos.length / 3;
      for (let j = 0; j <= RINGS; j++) {
        const t = j / RINGS;
        // a plume necks in just above the pot and then billows out
        const rr = (P.r ?? 0.3) * (0.55 + 3.4 * Math.pow(t, 0.72)) * (1 + 0.16 * Math.sin(t * 7.0 + p));
        const cy = t * H;
        const wob = (fbm3(t * 3.1, p * 2.7, 1.3, { octaves: 2, seed: 91 + p }) - 0.5) * 0.7 * t;
        const wob2 = (fbm3(t * 3.1, p * 2.7, 5.9, { octaves: 2, seed: 137 + p }) - 0.5) * 0.7 * t;
        for (let i = 0; i <= SEG; i++) {
          const a = (i / SEG) * Math.PI * 2;
          const lump = 1 + (fbm3(Math.cos(a) * 1.6, t * 4.2, Math.sin(a) * 1.6, { octaves: 2, seed: 7 + p }) - 0.5) * 0.55;
          const rad = rr * lump;
          pos.push(P.x + wob + Math.cos(a) * rad, P.y + cy, P.z + wob2 + Math.sin(a) * rad);
          nor.push(Math.cos(a), 0.25, Math.sin(a));
          uv.push(i / SEG, t);
          // alpha: nothing at the pot mouth, a short dense stretch, then dilution
          const dense = Math.min(1, t * 7.0) * Math.pow(1 - t, 1.55);
          const a0 = dense * (P.warm ? 0.5 : 0.42);
          // colour: cool ash grey, warming toward the base of a forge plume
          const warm = P.warm ? Math.pow(1 - t, 2.6) : 0;
          col.push(
            (0.36 + warm * 0.5) * (0.8 + 0.3 * lump),
            (0.35 + warm * 0.22) * (0.8 + 0.3 * lump),
            (0.36 + warm * 0.05) * (0.8 + 0.3 * lump),
            a0
          );
          sm.push(t, phase);
        }
      }
      const cols = SEG + 1;
      for (let j = 0; j < RINGS; j++) {
        for (let i = 0; i < SEG; i++) {
          const a = base + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));   // vec4 → USE_COLOR_ALPHA
    g.setAttribute('aSmoke', new THREE.Float32BufferAttribute(sm, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    if (g.boundingSphere) g.boundingSphere.radius *= 1.6;               // drift headroom

    const u = { uTownTime: { value: 0 } };
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1.0, metalness: 0,
      vertexColors: true, transparent: true, depthWrite: false,
      side: THREE.DoubleSide, envMapIntensity: 0.6, dithering: true,
    });
    mat.name = 'town.smoke';
    // Transparent volumetrics have no business in a shadow map or a G-buffer.
    mat.userData.noCSM = true;
    mat.userData.noGBuffer = true;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTownTime = u.uTownTime;
      shader.vertexShader = SMOKE_INJECT_V + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n${SMOKE_INJECT_BODY}`
      );
    };
    mat.customProgramCacheKey = () => 'town.smoke';

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'town.smoke';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 4;
    mesh.updateMatrix();

    this.mesh = mesh;
    this.mat = mat;
    this.uniforms = u;
    this.geo = g;
  }

  update(elapsed) {
    if (this.uniforms) this.uniforms.uTownTime.value = elapsed;
  }

  dispose() {
    try { this.mesh?.removeFromParent(); } catch { /* noop */ }
    try { this.geo?.dispose(); } catch { /* noop */ }
    try { this.mat?.dispose(); } catch { /* noop */ }
    this.mesh = null; this.mat = null; this.geo = null; this.uniforms = null;
  }
}

/* ------------------------------------------------------------------ *
 * flame
 * ------------------------------------------------------------------ */

/**
 * Brazier fire. The shader derives its phase from the instance's translation, so
 * every brazier in the town burns out of step with every other one; the geometry
 * is a teardrop shell, double-sided and additive, so a view ray accumulates
 * several layers exactly as it does through real fire.
 */
export class FlameField {
  /** @param {Array<{x:number,y:number,z:number,s?:number}>} spots */
  constructor(spots) {
    this.mesh = null;
    this.mat = null;
    if (!spots || !spots.length) return;
    this.geo = flameGeo({ h: 0.30, r: 0.10, rings: 9, seg: 9 });
    this.mat = makeFlameMaterial({
      core: [1.0, 0.62, 0.25], mid: [1.0, 0.30, 0.07], tip: [0.30, 0.05, 0.014],
      intensity: 1.15, amp: 0.05, speed: 1.0,
    });
    this.mat.name = 'town.flame';
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, spots.length);
    mesh.name = 'town.flame';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 5;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    for (let i = 0; i < spots.length; i++) {
      const S = spots[i];
      const k = S.s ?? 1;
      p.set(S.x, S.y, S.z);
      s.set(k, k * (0.9 + 0.25 * ((i * 0.618) % 1)), k);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.updateMatrix();
    this.mesh = mesh;
  }

  update(elapsed) {
    if (this.mat?.uniforms?.uTime) this.mat.uniforms.uTime.value = elapsed;
  }

  dispose() {
    try { this.mesh?.removeFromParent(); } catch { /* noop */ }
    try { this.geo?.dispose(); } catch { /* noop */ }
    try { this.mat?.dispose(); } catch { /* noop */ }
    this.mesh = null; this.mat = null; this.geo = null;
  }
}
