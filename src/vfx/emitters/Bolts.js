import * as THREE from 'three';

/**
 * THE NINTH VIGIL — procedural lightning.
 *
 * Each bolt is a set of polylines produced by recursive midpoint displacement:
 * split a segment, push the new midpoint along a random perpendicular by an
 * amount that halves every level, and occasionally fork a shorter, thinner,
 * dimmer child bolt off a midpoint. That is what gives lightning its
 * characteristic self-similar zig-zag; a hand-authored polyline never looks
 * right because real lightning has detail at every scale.
 *
 * The polylines are drawn as screen-facing fat lines: the vertex shader takes
 * each point plus its neighbour, projects both, and offsets along the 2D
 * perpendicular. So a bolt keeps a constant apparent width from any camera
 * angle and never collapses to a hairline when it points at the lens.
 *
 * Every strip lives in one shared geometry — the entire system is one draw call.
 */

const VERT = /* glsl */`
precision highp float;

uniform float uTime;
uniform float uPxScale;
uniform float uMinPx;

attribute vec3 aNext;
attribute vec4 aEdge;   // (side, u along bolt, width, dir sign)
attribute vec4 aBolt;   // (t0, life, intensity, seed)
attribute vec3 aCore;
attribute vec3 aGlow;

varying vec2 vUV;
varying vec3 vCore;
varying vec3 vGlow;
varying float vFade;
varying float vViewZ;
varying float vSeed;

void main() {
  float age = uTime - aBolt.x;
  float life = max( aBolt.y, 1e-4 );
  float u = age / life;
  if ( u < 0.0 || u >= 1.0 || aEdge.z <= 0.0 ) {
    vUV = vec2( 0.0 ); vCore = vec3( 0.0 ); vGlow = vec3( 0.0 );
    vFade = 0.0; vViewZ = -1.0; vSeed = 0.0;
    gl_Position = vec4( 0.0, 0.0, 2.0, 1.0 );
    return;
  }

  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vec4 mvN = modelViewMatrix * vec4( aNext, 1.0 );

  // Offset in the VIEW plane, perpendicular to the channel's screen-space
  // direction: the strip is therefore always camera-facing, its width is a true
  // world-space measure, and it can never collapse to a hairline.
  vec2 dir = mvN.xy - mv.xy;
  float dl = length( dir );
  dir = ( dl > 1e-6 ) ? dir / dl : vec2( 0.0, 1.0 );
  vec2 nrm = vec2( -dir.y, dir.x ) * aEdge.w;

  float w = max( aEdge.z, uMinPx * uPxScale * max( -mv.z, 0.05 ) );
  mv.xy += nrm * ( aEdge.x * w * 0.5 );
  vec4 cp = projectionMatrix * mv;

  // A bolt does not fade uniformly: it flashes, holds, then snaps out.
  float flash = smoothstep( 0.0, 0.06, u );
  float decay = 1.0 - smoothstep( 0.22, 1.0, u );
  vFade = flash * decay * aBolt.z;

  vUV = vec2( aEdge.y, aEdge.x );
  vCore = aCore;
  vGlow = aGlow;
  vViewZ = mv.z;
  vSeed = aBolt.w;
  gl_Position = cp;
}
`;

const FRAG = /* glsl */`
precision highp float;

uniform sampler2D uDepth;
uniform vec2 uInvRes;
uniform vec2 uClip;
uniform float uSoftOn;
uniform float uTime;
uniform float uMaxRad;    // scene-linear ceiling for one additive fragment

varying vec2 vUV;
varying vec3 vCore;
varying vec3 vGlow;
varying float vFade;
varying float vViewZ;
varying float vSeed;

float sat( float x ) { return clamp( x, 0.0, 1.0 ); }

void main() {
  float d = abs( vUV.y );
  // Thin white-hot filament inside a wide soft glow — the whole read.
  float core = pow( sat( 1.0 - d * 3.2 ), 2.0 );
  float glow = pow( sat( 1.0 - d ), 2.6 );

  // Slight brightness crawl along the channel so it is not a uniform tube.
  float crawl = 0.78 + 0.22 * sin( vUV.x * 34.0 + vSeed * 21.0 + uTime * 26.0 );

  float a = sat( ( core * 1.0 + glow * 0.5 ) * vFade * crawl );
  if ( a < 0.004 ) discard;

  if ( uSoftOn > 0.5 ) {
    float dz = texture2D( uDepth, gl_FragCoord.xy * uInvRes ).x;
    float sceneZ = ( uClip.x * uClip.y ) / ( ( uClip.y - uClip.x ) * dz - uClip.y );
    a *= sat( ( vViewZ - sceneZ ) / 0.35 );
  }

  vec3 col = mix( vGlow, vCore, core );

  /* Same hard radiance ceiling the sprite batch uses: additive blending sends
     col * a to the HDR buffer, the pipeline multiplies that by the exposure
     gain, and anything past ~1.55 post-gain pins white under ACES. Roll the
     premultiplied peak off to uMaxRad with an exponential knee so a bolt core
     keeps its blue-white hue instead of clipping to a flat white ribbon. */
  vec3 c = col * a;
  float peak = max( c.r, max( c.g, c.b ) );
  float knee = uMaxRad * 0.55;
  if ( peak > knee ) {
    float head = max( uMaxRad - knee, 1e-4 );
    float rolled = knee + head * ( 1.0 - exp( -( peak - knee ) / head ) );
    c *= rolled / max( peak, 1e-5 );
  }
  gl_FragColor = vec4( c, 1.0 );
}
`;

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _perp2 = new THREE.Vector3();

export class BoltSystem {
  /**
   * @param {object} o
   * @param {number} [o.strips]   polyline pool size (main bolts + branches)
   * @param {number} [o.segments] segments per polyline
   */
  constructor(o = {}) {
    this.maxStrips = Math.max(2, o.strips ?? 28);
    this.seg = Math.max(4, o.segments ?? 16);
    const pts = this.seg + 1;
    this.vpr = pts * 2;
    const total = this.maxStrips * this.vpr;

    this.pos = new Float32Array(total * 3);
    this.nxt = new Float32Array(total * 3);
    this.edge = new Float32Array(total * 4);
    this.bolt = new Float32Array(total * 4);
    this.core = new Float32Array(total * 3);
    this.glow = new Float32Array(total * 3);

    const geo = new THREE.BufferGeometry();
    const mk = (arr, n) => {
      const a = new THREE.BufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = mk(this.pos, 3);
    this.aNxt = mk(this.nxt, 3);
    this.aEdge = mk(this.edge, 4);
    this.aBolt = mk(this.bolt, 4);
    this.aCore = mk(this.core, 3);
    this.aGlow = mk(this.glow, 3);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aNext', this.aNxt);
    geo.setAttribute('aEdge', this.aEdge);
    geo.setAttribute('aBolt', this.aBolt);
    geo.setAttribute('aCore', this.aCore);
    geo.setAttribute('aGlow', this.aGlow);

    const idx = new Uint16Array(this.maxStrips * this.seg * 6);
    let w = 0;
    for (let s = 0; s < this.maxStrips; s++) {
      const base = s * this.vpr;
      for (let i = 0; i < this.seg; i++) {
        const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx[w++] = a; idx[w++] = c; idx[w++] = b;
        idx[w++] = b; idx[w++] = c; idx[w++] = d;
      }
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.geometry = geo;

    this.uniforms = {
      uTime: { value: 0 },
      uPxScale: { value: 0.002 },
      uMinPx: { value: 1.6 },
      uDepth: { value: null },
      uInvRes: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
      uClip: { value: new THREE.Vector2(0.25, 900) },
      uSoftOn: { value: 0 },
      uMaxRad: { value: 0.84 },
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
    this.material.name = 'Nona.vfxBolts';
    this.material.userData.noCSM = true;

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'vfxBolts';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 21;
    this.mesh.userData.noGBuffer = true;
    this.mesh.userData.noCSM = true;
    this.mesh.visible = false;

    /** per-strip expiry, so the pool recycles oldest-first */
    this._exp = new Float32Array(this.maxStrips);
    this._exp.fill(-1e9);
    this._head = 0;
    this._maxExp = -1e9;
    this._live = 0;
    this._pts = new Float32Array((this.seg + 1) * 3);
  }

  get live() { return this._live; }

  /**
   * Fire a branched bolt from A to B.
   * @param {object} o { ax..bz, width, life, core:Color, glow:Color,
   *                     intensity, branches, jitter, seed, now, rnd }
   */
  strike(o) {
    const rnd = o.rnd;
    const now = o.now;
    const life = o.life ?? 0.2;
    const width = o.width ?? 0.07;
    const inten = o.intensity ?? 3.0;

    this._emitPolyline(o.ax, o.ay, o.az, o.bx, o.by, o.bz,
      width, life, inten, o.core, o.glow, o.jitter ?? 0.4, rnd, now, o.seed ?? 0);

    const branches = Math.max(0, o.branches ?? 3);
    for (let i = 0; i < branches; i++) {
      // Branch off a point partway down the trunk, heading off-axis.
      const t = rnd.range(0.18, 0.8);
      const sx = o.ax + (o.bx - o.ax) * t;
      const sy = o.ay + (o.by - o.ay) * t;
      const sz = o.az + (o.bz - o.az) * t;
      _dir.set(o.bx - o.ax, o.by - o.ay, o.bz - o.az);
      const trunk = _dir.length() || 1;
      _dir.multiplyScalar(1 / trunk);
      this._perpBasis(_dir);
      const a = rnd() * Math.PI * 2;
      const spread = rnd.range(0.35, 0.95);
      _q.copy(_dir).multiplyScalar(rnd.range(0.25, 0.7));
      _q.addScaledVector(_perp, Math.cos(a) * spread);
      _q.addScaledVector(_perp2, Math.sin(a) * spread);
      _q.normalize().multiplyScalar(trunk * rnd.range(0.18, 0.45));
      this._emitPolyline(
        sx, sy, sz, sx + _q.x, sy + _q.y, sz + _q.z,
        width * rnd.range(0.4, 0.7), life * rnd.range(0.55, 0.9),
        inten * rnd.range(0.45, 0.75), o.core, o.glow,
        (o.jitter ?? 0.4) * 0.7, rnd, now + rnd.range(0, 0.02), rnd()
      );
    }
  }

  _perpBasis(d) {
    if (Math.abs(d.y) < 0.92) _perp.set(0, 1, 0).cross(d).normalize();
    else _perp.set(1, 0, 0).cross(d).normalize();
    _perp2.copy(d).cross(_perp).normalize();
  }

  /**
   * Recursive midpoint displacement into `_pts`, then written into a strip.
   * The displacement halves per level, which is what makes the zig-zag
   * self-similar instead of a single wobble.
   */
  _emitPolyline(ax, ay, az, bx, by, bz, width, life, inten, core, glow, jitter, rnd, now, seed) {
    const n = this.seg;
    const pts = this._pts;
    pts[0] = ax; pts[1] = ay; pts[2] = az;
    pts[n * 3] = bx; pts[n * 3 + 1] = by; pts[n * 3 + 2] = bz;

    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length() || 1;
    _dir.multiplyScalar(1 / len);
    this._perpBasis(_dir);
    const px = _perp.x, py = _perp.y, pz = _perp.z;
    const qx = _perp2.x, qy = _perp2.y, qz = _perp2.z;

    // levels: n must be a power of two for a clean recursion; step down anyway.
    let stride = n;
    let amp = jitter * len * 0.22;
    while (stride > 1) {
      const half = stride >> 1;
      for (let i = half; i < n; i += stride) {
        const a0 = (i - half) * 3, a1 = (i + half) * 3, m = i * 3;
        const mx = (pts[a0] + pts[a1]) * 0.5;
        const my = (pts[a0 + 1] + pts[a1 + 1]) * 0.5;
        const mz = (pts[a0 + 2] + pts[a1 + 2]) * 0.5;
        const u = rnd.gauss(0, 0.55) * amp;
        const w = rnd.gauss(0, 0.55) * amp;
        pts[m] = mx + px * u + qx * w;
        pts[m + 1] = my + py * u + qy * w;
        pts[m + 2] = mz + pz * u + qz * w;
      }
      stride = half;
      amp *= 0.52;
    }

    /* --- write into a pooled strip --- */
    const slot = this._head;
    this._head = (this._head + 1) % this.maxStrips;
    const exp = now + life;
    this._exp[slot] = exp;
    if (exp > this._maxExp) this._maxExp = exp;

    const base = slot * this.vpr;
    const cr = core?.r ?? 1, cg = core?.g ?? 1, cb = core?.b ?? 1;
    const gr = glow?.r ?? 0.5, gg = glow?.g ?? 0.7, gb = glow?.b ?? 1;
    for (let i = 0; i <= n; i++) {
      const nextI = Math.min(i + 1, n);
      const prevI = Math.max(i - 1, 0);
      // Use the forward neighbour except at the tail, where we look backward so
      // the perpendicular stays defined.
      const ni = i < n ? nextI : prevI;
      const u = i / n;
      // taper the ends so the bolt does not stop with a blunt cap
      const taper = Math.min(1, Math.sin(Math.PI * Math.min(1, 0.06 + u * 0.94)) * 1.6);
      for (let sIdx = 0; sIdx < 2; sIdx++) {
        const vi = base + i * 2 + sIdx;
        let o3 = vi * 3;
        this.pos[o3] = pts[i * 3];
        this.pos[o3 + 1] = pts[i * 3 + 1];
        this.pos[o3 + 2] = pts[i * 3 + 2];
        this.nxt[o3] = pts[ni * 3];
        this.nxt[o3 + 1] = pts[ni * 3 + 1];
        this.nxt[o3 + 2] = pts[ni * 3 + 2];
        this.core[o3] = cr; this.core[o3 + 1] = cg; this.core[o3 + 2] = cb;
        this.glow[o3] = gr; this.glow[o3 + 1] = gg; this.glow[o3 + 2] = gb;
        const o4 = vi * 4;
        this.edge[o4] = sIdx === 0 ? -1 : 1;
        this.edge[o4 + 1] = u;
        this.edge[o4 + 2] = width * taper;
        this.edge[o4 + 3] = i < n ? 1 : -1;
        this.bolt[o4] = now;
        this.bolt[o4 + 1] = life;
        this.bolt[o4 + 2] = inten;
        this.bolt[o4 + 3] = seed;
      }
    }
    this._dirty = true;
  }

  flush(now, pxScale) {
    this.uniforms.uTime.value = now;
    this.uniforms.uPxScale.value = pxScale;
    if (this._dirty) {
      this.aPos.needsUpdate = true;
      this.aNxt.needsUpdate = true;
      this.aEdge.needsUpdate = true;
      this.aBolt.needsUpdate = true;
      this.aCore.needsUpdate = true;
      this.aGlow.needsUpdate = true;
      this._dirty = false;
    }
    let live = 0;
    for (let i = 0; i < this.maxStrips; i++) if (this._exp[i] > now) live++;
    this._live = live;
    this.mesh.visible = live > 0;
  }

  /** Scene-linear ceiling for one additive fragment (see VFXSystem). */
  setMaxRadiance(v) {
    if (Number.isFinite(v)) this.uniforms.uMaxRad.value = v;
  }

  setDepth(tex, invResX, invResY, near, far) {
    this.uniforms.uDepth.value = tex;
    this.uniforms.uSoftOn.value = tex ? 1 : 0;
    this.uniforms.uInvRes.value.set(invResX, invResY);
    this.uniforms.uClip.value.set(near, far);
  }

  clear() {
    this._exp.fill(-1e9);
    this._maxExp = -1e9;
    this._head = 0;
    this.bolt.fill(0);
    for (let i = 0; i < this.bolt.length; i += 4) this.bolt[i] = -1e9;
    this.edge.fill(0);
    this._dirty = true;
    this.mesh.visible = false;
    this._live = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
