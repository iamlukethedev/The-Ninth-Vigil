import * as THREE from 'three';

/**
 * THE NINTH VIGIL — swept ribbon trails.
 *
 * A weapon trail is a quad strip built from the blade's *measured* swept
 * positions: one edge follows the hilt, the other the tip. That is what makes
 * it read as a motion smear of a real object instead of a glowing banner
 * stapled to the hand.
 *
 * Two failure modes are handled explicitly, because both are visible instantly:
 *
 *  - **Kinking / self-intersection on fast swings.** At 25 m/s of tip speed a
 *    60 Hz sample lands 0.4 m from the last one, and a strip built straight from
 *    those samples facets — and if the blade rotates more than a right angle
 *    between samples the quad folds through itself. `push()` therefore
 *    subdivides any step longer than `maxStep`, interpolating the *hilt*
 *    linearly and the blade *direction* by normalised lerp at constant blade
 *    length. Constant length is the part that matters: it guarantees the two
 *    edges stay on the same side of each other, so the strip cannot fold.
 *  - **Hard edges.** The ribbon fades across its width with an authored falloff
 *    and along its length with a taper, is additive, and samples the depth
 *    prepass so it fades where it passes into the floor.
 *
 * All ribbons share one geometry and one material: the whole system is a single
 * draw call regardless of how many trails are live.
 */

const VERT = /* glsl */`
precision highp float;

uniform float uTime;

attribute vec3 aColor;     // per-vertex tint * gain
attribute vec3 aParam;     // (u along length, v across width, alpha)

varying vec3 vColor;
varying vec2 vUV;
varying float vAlpha;
varying float vViewZ;

void main() {
  vColor = aColor;
  vUV = aParam.xy;
  vAlpha = aParam.z;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uClip;
uniform float uSoftOn;
uniform float uGain;

varying vec3 vColor;
varying vec2 vUV;
varying float vAlpha;
varying float vViewZ;

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

void main() {
  // Across the width: bright toward the tip edge, soft to nothing at the hilt.
  float v = vUV.y;
  float radial = smoothstep( 0.0, 0.62, v ) * ( 1.0 - smoothstep( 0.93, 1.0, v ) );
  float core = pow( sat( ( v - 0.55 ) / 0.45 ), 2.2 );
  // Along the length: taper the old end out entirely.
  float along = pow( 1.0 - vUV.x, 1.75 );

  float a = ( radial * 0.62 + core * 0.75 ) * along * vAlpha * uGain;
  if ( a < 0.004 ) discard;

  if ( uSoftOn > 0.5 ) {
    float d = texture2D( uDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = ( uClip.x * uClip.y ) / ( ( uClip.y - uClip.x ) * d - uClip.y );
    a *= sat( ( vViewZ - sceneZ ) / 0.30 );
  }

  vec3 col = vColor * ( 0.55 + core * 1.35 );
  gl_FragColor = vec4( col, sat( a ) );
}
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d0 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _di = new THREE.Vector3();
const _hi = new THREE.Vector3();

/** One pooled ribbon. Holds its own sample ring; the mesh is shared. */
class Ribbon {
  constructor(samples) {
    this.n = samples;
    // sample ring: inner (hilt) + outer (tip) per sample
    this.inner = new Float32Array(samples * 3);
    this.outer = new Float32Array(samples * 3);
    this.count = 0;
    this.head = 0;
    this.active = false;
    this.gain = 0;
    this.taper = 0.55;
    this.maxStep = 0.34;
    this.color = new THREE.Color(0xcfe0ff);
    this.id = 0;
    this.idle = 0;
    /* Blade length of the newest sample. A weapon trail is the smear of ONE
       object, so both the sample-to-sample step and the blade length itself are
       bounded — a violation of either means the feed jumped, not that the swing
       was fast. */
    this.bladeLen = 0;
  }

  reset() {
    this.count = 0;
    this.head = 0;
    this.gain = 0;
    this.idle = 0;
    this.bladeLen = 0;
  }

  _write(hx, hy, hz, tx, ty, tz) {
    const i = this.head * 3;
    this.inner[i] = hx; this.inner[i + 1] = hy; this.inner[i + 2] = hz;
    this.outer[i] = tx; this.outer[i + 1] = ty; this.outer[i + 2] = tz;
    this.head = (this.head + 1) % this.n;
    if (this.count < this.n) this.count++;
  }

  /** Newest-first sample index → ring index. */
  _idx(k) { return ((this.head - 1 - k) % this.n + this.n) % this.n; }

  /** Wipe the ring and re-seed it at a single pose. Draws nothing this frame. */
  _seed(hilt, tip) {
    this.count = 0;
    this.head = 0;
    for (let i = 0; i < this.n; i++) {
      this._write(hilt.x, hilt.y, hilt.z, tip.x, tip.y, tip.z);
    }
    this.bladeLen = hilt.distanceTo(tip);
    /* One frame of silence. Fading in from a seeded ring is correct; welding the
       first post-jump quad onto the pre-jump samples is what produces a strip
       stretched across the whole play area. */
    this.gain = 0;
  }

  /**
   * Append a swept sample. `hilt`/`tip` are world-space blade ends.
   * Subdivides long steps at constant blade length so the strip cannot fold.
   *
   * DISCONTINUITY IS NOT MOTION. The `maxStep` subdivision below assumes the
   * samples describe a continuous sweep, and it cannot tell a fast swing from a
   * teleport — an entity respawn, a scenario reset, a socket swapping to another
   * hand, or a paused tab resuming. Subdividing across a jump welds two
   * unrelated poses into one enormous quad, which is exactly how a weapon trail
   * turns into a hard-edged strip drawn across the entire frame. So a jump
   * larger than a few sample steps, or a blade that changes length by more than
   * half, hard-resets the ring instead of interpolating through it.
   */
  push(hilt, tip) {
    if (this.count === 0) {
      this._seed(hilt, tip);
      return;
    }
    const p = this._idx(0) * 3;
    _a.set(this.inner[p], this.inner[p + 1], this.inner[p + 2]);
    _b.set(this.outer[p], this.outer[p + 1], this.outer[p + 2]);

    const hiltStep = _a.distanceTo(hilt);
    const blade = hilt.distanceTo(tip);
    const prevBlade = this.bladeLen || blade || 1e-4;
    if (
      !Number.isFinite(hiltStep) || !Number.isFinite(blade) ||
      hiltStep > this.maxStep * 3 ||
      blade > prevBlade * 1.6 || blade < prevBlade * 0.62
    ) {
      this._seed(hilt, tip);
      return;
    }
    this.bladeLen = blade;
    /* Hard ceiling on how much WORLD the emitted strip may span. A swept blade
       is one object: over the fast part of an arc its tip covers a couple of
       blade lengths, never a dozen. Any sample further than that from the newest
       one is not part of this smear, so the tail is trimmed rather than drawn —
       an O(1) check per frame that makes a frame-spanning strip unrepresentable
       even if a jump slips past the test above. */
    const maxSpan = Math.max(1.6, blade * 4.0);
    const maxSpan2 = maxSpan * maxSpan;
    let guard = 0;
    while (this.count > 2 && guard++ < this.n) {
      const q = this._idx(this.count - 1) * 3;
      const dx = this.outer[q] - tip.x;
      const dy = this.outer[q + 1] - tip.y;
      const dz = this.outer[q + 2] - tip.z;
      if (dx * dx + dy * dy + dz * dz <= maxSpan2) break;
      this.count--;
    }

    const step = _b.distanceTo(tip);
    const sub = step > this.maxStep ? Math.min(4, Math.ceil(step / this.maxStep)) : 1;
    if (sub === 1) {
      this._write(hilt.x, hilt.y, hilt.z, tip.x, tip.y, tip.z);
      return;
    }
    _d0.copy(_b).sub(_a);
    _d1.copy(tip).sub(hilt);
    const l0 = _d0.length() || 1e-4;
    const l1 = _d1.length() || 1e-4;
    _d0.multiplyScalar(1 / l0);
    _d1.multiplyScalar(1 / l1);
    for (let j = 1; j <= sub; j++) {
      const t = j / sub;
      _hi.copy(_a).lerp(hilt, t);
      _di.copy(_d0).lerp(_d1, t);
      const dl = _di.length();
      if (dl < 1e-5) _di.copy(_d1); else _di.multiplyScalar(1 / dl);
      const len = l0 + (l1 - l0) * t;
      this._write(
        _hi.x, _hi.y, _hi.z,
        _hi.x + _di.x * len, _hi.y + _di.y * len, _hi.z + _di.z * len
      );
    }
  }
}

export class TrailSystem {
  /**
   * @param {object} o
   * @param {number} [o.ribbons]  pool size
   * @param {number} [o.samples]  samples per ribbon
   */
  constructor(o = {}) {
    this.maxRibbons = Math.max(1, o.ribbons ?? 6);
    this.samples = Math.max(6, o.samples ?? 26);
    const segs = this.samples - 1;
    const vertsPerRibbon = this.samples * 2;
    const total = this.maxRibbons * vertsPerRibbon;

    this.pos = new Float32Array(total * 3);
    this.col = new Float32Array(total * 3);
    this.par = new Float32Array(total * 3);

    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 3);
    this.aPar = new THREE.BufferAttribute(this.par, 3);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    this.aPar.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aColor', this.aCol);
    geo.setAttribute('aParam', this.aPar);

    const idx = new Uint16Array(this.maxRibbons * segs * 6);
    let w = 0;
    for (let r = 0; r < this.maxRibbons; r++) {
      const base = r * vertsPerRibbon;
      for (let i = 0; i < segs; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[w++] = a; idx[w++] = c; idx[w++] = b;
        idx[w++] = b; idx[w++] = c; idx[w++] = d;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;

    this.uniforms = {
      uTime: { value: 0 },
      uDepth: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uClip: { value: new THREE.Vector2(0.25, 900) },
      uSoftOn: { value: 0 },
      uGain: { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.material.name = 'Nona.vfxTrails';
    this.material.userData.noCSM = true;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'vfxTrails';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 19;
    this.mesh.userData.noGBuffer = true;
    this.mesh.userData.noCSM = true;
    this.mesh.visible = false;

    this.ribbons = [];
    for (let i = 0; i < this.maxRibbons; i++) {
      const rb = new Ribbon(this.samples);
      rb.id = i;
      this.ribbons.push(rb);
    }
    this._segs = segs;
    this._vpr = vertsPerRibbon;
  }

  /** Grab a free ribbon. Returns null when the pool is exhausted. */
  acquire(opts = {}) {
    for (let i = 0; i < this.ribbons.length; i++) {
      const rb = this.ribbons[i];
      if (rb.active) continue;
      rb.active = true;
      rb.reset();
      if (opts.color !== undefined) rb.color.set(opts.color);
      rb.taper = opts.taper ?? 0.55;
      rb.maxStep = opts.maxStep ?? 0.34;
      return rb;
    }
    return null;
  }

  release(rb) {
    if (!rb) return;
    rb.active = false;
    rb.reset();
  }

  clear() {
    for (const rb of this.ribbons) { rb.active = false; rb.reset(); }
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  /**
   * Rebuild the shared buffers from every live ribbon. Cheap: a few hundred
   * vertices, and only the ribbons that are actually visible are written.
   */
  build() {
    const pos = this.pos, col = this.col, par = this.par;
    let usedRibbons = 0;
    let maxIndex = 0;

    for (let r = 0; r < this.ribbons.length; r++) {
      const rb = this.ribbons[r];
      const slot = r;
      const base = slot * this._vpr;
      if (!rb.active || rb.gain <= 0.008 || rb.count < 2) {
        // collapse the strip: zero alpha, degenerate positions
        for (let i = 0; i < this._vpr; i++) {
          const o = (base + i) * 3;
          par[o] = 0; par[o + 1] = 0; par[o + 2] = 0;
          pos[o] = 0; pos[o + 1] = -9999; pos[o + 2] = 0;
        }
        continue;
      }
      usedRibbons++;
      const n = rb.count;
      const cr = rb.color.r * rb.gain;
      const cg = rb.color.g * rb.gain;
      const cb = rb.color.b * rb.gain;
      for (let k = 0; k < this.samples; k++) {
        const kk = Math.min(k, n - 1);
        const src = rb._idx(kk) * 3;
        const u = k / (this.samples - 1);
        // taper: pull the outer edge toward the hilt as the sample ages
        const shrink = 1 - rb.taper * u;
        const hx = rb.inner[src], hy = rb.inner[src + 1], hz = rb.inner[src + 2];
        const tx = rb.outer[src], ty = rb.outer[src + 1], tz = rb.outer[src + 2];
        const ox = hx + (tx - hx) * shrink;
        const oy = hy + (ty - hy) * shrink;
        const oz = hz + (tz - hz) * shrink;

        /* Zero-width guard. When the two edges of a segment land within a
           centimetre of each other the width falloff in the fragment shader is
           evaluated at both v=0 and v=1 inside a single pixel, so the interior
           term never gets sampled and the segment renders as its own outline —
           a hollow hard-edged sliver. Kill the alpha instead of shading it. */
        const ew = Math.abs(tx - hx) + Math.abs(ty - hy) + Math.abs(tz - hz);
        const alpha = ew < 0.01 ? 0 : 1;

        let o = (base + k * 2) * 3;
        pos[o] = hx; pos[o + 1] = hy; pos[o + 2] = hz;
        col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
        par[o] = u; par[o + 1] = 0; par[o + 2] = alpha;

        o += 3;
        pos[o] = ox; pos[o + 1] = oy; pos[o + 2] = oz;
        col[o] = cr; col[o + 1] = cg; col[o + 2] = cb;
        par[o] = u; par[o + 1] = 1; par[o + 2] = alpha;
      }
      maxIndex = Math.max(maxIndex, (slot + 1) * this._segs * 6);
    }

    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.aPar.needsUpdate = true;
    this.geometry.setDrawRange(0, maxIndex);
    this.mesh.visible = usedRibbons > 0;
  }

  setDepth(tex, invResX, invResY, near, far) {
    this.uniforms.uDepth.value = tex;
    this.uniforms.uSoftOn.value = tex ? 1 : 0;
    this.uniforms.uInvRes.value.set(invResX, invResY);
    this.uniforms.uClip.value.set(near, far);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
