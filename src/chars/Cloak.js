/**
 * THE NINTH VIGIL — Cloak
 * ---------------------------------------------------------------------------
 * A verlet cloth grid pinned across the hero's pauldrons. This is the only
 * part of the character that is simulated rather than skinned, because a cloak
 * is the cheapest, most legible way to sell weight and motion: it lags the
 * body on a turn, flares on a dash and settles with real inertia.
 *
 * Solver
 * ------
 *  • Position-based verlet in **world space** (the bone tree is parented to the
 *    hero root, so bone world matrices are already world — no basis juggling).
 *  • Three substeps per frame, five Gauss–Seidel constraint iterations each.
 *    Distance constraints on the structural grid, on the shear diagonals, and
 *    on skip-2 neighbours (the bend/flexural term). Without the bend term a
 *    verlet cloth folds into paper creases; with it, the fabric holds a drape.
 *  • Velocity damping is applied to the *verlet integrator* (a multiplier on
 *    the implicit velocity) rather than as a force, which is unconditionally
 *    stable and is what stops the high-frequency buzz that makes cheap cloth
 *    look like foil.
 *  • Collision against a body capsule (pelvis→neck) plus a hip sphere and the
 *    terrain surface, resolved as projection with friction so the hem does not
 *    slide through the greaves.
 *
 * Shape
 * -----
 * The rest state is **not planar**. A verlet sheet whose rest lengths describe a
 * flat quad has no reason to buckle, so it will hang as a flat quad forever no
 * matter how many particles it has — which is exactly what the first pass
 * rendered: a black rectangle with square corners. The folds, the scalloped hem
 * and the rounded corners are all baked into the rest *shape* here, and the
 * distance constraints then preserve them for the life of the simulation.
 *
 * Determinism: dt is the engine's fixed step, wind comes from the weather
 * module's deterministic field, and the initial state is relaxed by a fixed
 * number of iterations at init. No Math.random, no wall clock.
 */

import * as THREE from 'three';

/* Grid resolution is a *shape* decision, not a fidelity knob. A fold needs
   roughly four columns per cycle to survive the distance constraints, so at 13
   columns the sheet could carry at most two gentle undulations across its width
   — which is why the drape read as a smooth flat panel no matter how deep the
   rest-shape folds were authored.
   21 columns across a 1.18 m hem is a 56 mm sample spacing, which carries five
   fold channels at 4.2 columns each. At 17 it was four channels but the
   *shading* of each was reconstructed from 4 vertices with smooth normals, so
   the shadow terminator across a fold spanned a single quad and the drape read
   as a soft cone. This is the resolution below which no amount of bend stiffness
   produces a readable fold, and it is why the art director saw "a cone cloak
   with no fold structure" while the solver was, technically, folding. */
const COLS = 21;          // across the shoulders
const ROWS = 21;          // down the back
const SUBSTEPS = 3;
const ITER = 4;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0 || 1e-6)); return t * t * (3 - 2 * t); };

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _p = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();

const CLOAK_FRAG_HEAD = /* glsl */`
uniform vec3  uOuter;
uniform vec3  uLining;
uniform vec4  uCloakHue;   // rgb: luminance-normalised chroma, a: force amount
uniform float uCloakAlb;
uniform float uHemDark;
uniform vec2  uFoldAO;     // x: albedo darkening in the valleys, y: roughness add
uniform vec4  uCloakRim;
uniform vec4  uCloakGrade;
varying float vCloakV;
varying float vCloakAO;
`;
/**
 * Same hue discipline as the armour, and for the same reason: the `cloth`
 * generator is oxblood wool authored at 0.26 linear and written into an
 * sRGB-encoded texture, so sampled raw it is both far too dark and exactly the
 * hue of a firelit stone floor. Force the chroma, lift the value, then tint
 * front and back faces separately — a cloak's inside is a lining, not the same
 * bolt of cloth, and that two-tone flash is most of what sells the motion.
 */
const CLOAK_FRAG_BODY = /* glsl */`
  {
    float l = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, l * uCloakHue.rgb, uCloakHue.a ) * uCloakAlb;
    diffuseColor.rgb *= gl_FrontFacing ? uOuter : uLining;
    // the hem darkens where it drags through dust
    diffuseColor.rgb *= 1.0 - uHemDark * smoothstep( 0.58, 1.0, vCloakV );
    /* Baked fold occlusion. Without this the drape is invisible whenever the
       visible face is turned away from the practicals — which, on a cloak worn
       behind a figure lit from the front, is most of the time. Wool that gathers
       into a channel is darker AND rougher at the bottom of the channel, so both
       move together; decoupling them is what makes cheap cloth read as vinyl. */
    float ao = smoothstep( 0.06, 0.94, vCloakAO );
    diffuseColor.rgb *= 1.0 - uFoldAO.x * ao;
    roughnessFactor = clamp( roughnessFactor + uFoldAO.y * ao, 0.04, 1.0 );
  }
`;
const CLOAK_FRAG_EMIT = /* glsl */`
  {
    float ndv = clamp( dot( normalize( vViewPosition ), normalize( normal ) ), 0.0, 1.0 );
    totalEmissiveRadiance += uCloakRim.rgb * ( pow( 1.0 - ndv, 3.0 ) * uCloakRim.a );
  }
`;
/** Same post-lighting hue balance the armour uses — see CharacterMesh. */
const CLOAK_FRAG_GRADE = /* glsl */`
  {
    float l = dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) );
    float g = uCloakGrade.a * ( 1.0 - 0.58 * smoothstep( 0.30, 1.30, l ) );
    outgoingLight = mix( outgoingLight, l * uCloakGrade.rgb, g );
  }
`;

export class Cloak {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {import('./Skeleton.js').Rig} rig
   * @param {Array<{bone:string, offset:THREE.Vector3}>} anchors pin line, left→right
   */
  constructor(engine, rig, anchors, opts = {}) {
    this.engine = engine;
    this.rig = rig;
    this.anchors = anchors && anchors.length >= 2 ? anchors : null;
    this.enabled = true;

    this.width0 = opts.width0 ?? 0.60;   // span at the pin line
    /** Absolute hem span, metres. Measured against the *actual* pin span, not
     *  used as a ratio: the pin line is 0.43 m across, so the first pass's
     *  ratio arithmetic produced a 0.69 m hem instead of the intended 1.06 and
     *  the cloak hung as a narrow board. */
    this.width1 = opts.width1 ?? 1.06;
    /** MEASURED against the actual pin line, which is the fix here.
     *
     *  CharacterMesh._anchors pins this sheet at y = 1.534 - 1.554 m (across the
     *  tops of the pauldrons), NOT at the 1.85 m the previous value was solved
     *  for. 1.34 m of drop from 1.55 m therefore put the hem at 0.21 m — ankle
     *  height — where `_collide`'s terrain clamp (ground + 12 mm) caught it every
     *  substep. A hem pinned against the floor cannot swing, cannot flare and
     *  cannot hold a fold: it splays outward into a flat skirt, and because the
     *  collider only knows the terrain height field and not the rubble standing on
     *  it, the splayed hem also passes straight through props.
     *  1.10 m from a 1.55 m pin puts the hem at 0.45 m: mid-calf on a 1.85 m
     *  figure, clear of the floor at rest and through the whole stride, which is
     *  where a fighting cloak is actually cut to — and it is the only length at
     *  which the fold measurements above are worth anything, because a hem lying
     *  on the ground has its folds ironed out by the collision. */
    this.length = opts.length ?? 1.10;
    this.stiff = opts.stiff ?? 0.86;
    /** Flexural stiffness on the skip-2 constraints.
     *
     *  This is the number that decides whether cloth *folds* or merely *sags*.
     *  A verlet sheet with a weak bend term relaxes toward its minimum-area
     *  configuration, which for a pinned trapezoid is a smooth cone — the authored
     *  rest folds bleed out of it over the first second of simulation and never
     *  come back, which is why the previous pass could have folds in `_layoutRest`
     *  and still render as a cone. The skip-2 constraints are the only thing that
     *  resists that, so their stiffness is the fold's survival rate.
     *
     *  MEASURED at 0.30, on the capture harness's own 60-frame settle (fit a cubic
     *  across each row and take the residual, i.e. the deviation from a smooth
     *  drape):
     *      row  6 of 21 :  38 mm RMS,  92 mm peak,  5 channels
     *      row 11       :  60 mm RMS, 136 mm peak,  5 channels
     *      row 16       :  82 mm RMS, 153 mm peak,  4.5 channels
     *      row 20 (hem) :  99 mm RMS, 147 mm peak,  4.5 channels
     *  Five standing channels deepening toward the hem is drapery. Wool has real
     *  bending resistance and gathers into channels; silk does not, and 0.16 was
     *  a silk number. */
    this.bendStiff = opts.bendStiff ?? 0.30;
    this.damp = opts.damp ?? 0.984;
    // Deliberately small. A cloak that streams horizontally reads as a flag on
    // a pole; the drape is the point, and the motion should be a lag, not lift.
    this.windGain = opts.windGain ?? 0.10;
    /** Hard ceiling on wind alone: gravity is 9.81, and anything past ~a third
     *  of that holds the sheet out at 20°+ from plumb permanently. */
    this.maxWind = opts.maxWind ?? 2.6;
    this.maxAccel = opts.maxAccel ?? 4.2;
    /** Time constant of the pull toward the skinned rest drape, seconds. */
    this.restTau = opts.restTau ?? 0.20;
    /** How much of that pull survives at the hem (0 = hem fully simulated). */
    this.hemFree = opts.hemFree ?? 0.035;
    this.mass = opts.mass ?? 1.0;

    this.n = COLS * ROWS;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.rest = new Float32Array(this.n * 3);      // rig-space rest shape
    this.pinned = new Uint8Array(this.n);
    this.pinTarget = new Float32Array(COLS * 3);
    /** Baked fold occlusion, 0 = crest, 1 = valley. See `_layoutRest`. */
    this.foldAO = new Float32Array(this.n);

    /** distance constraints: [i, j, restLen, stiffness] flattened */
    this._cons = [];
    this._consLen = [];
    this._consStiff = [];

    this.mesh = null;
    this.material = null;
    this.geometry = null;
    this._posAttr = null;
    this._norAttr = null;
    this._uniforms = null;

    this._anchorPrev = new THREE.Vector3();
    this._hasPrev = false;
    this._capA = new THREE.Vector3();
    this._capB = new THREE.Vector3();
    this._hip = new THREE.Vector3();
    this._flair = 0;
  }

  /* ------------------------------------------------------------ build */

  build() {
    this._layoutRest();
    this._buildConstraints();
    this._buildMesh();
    return this.mesh;
  }

  /**
   * Rest layout in rig space: the pin line follows the anchors, then the sheet
   * falls with a slight backward bow and a widening hem.
   */
  _layoutRest() {
    const top = [];
    if (this.anchors) {
      for (const a of this.anchors) {
        const r = this.rig.rest(a.bone, new THREE.Vector3());
        top.push(r.add(a.offset));
      }
    } else {
      // No sockets supplied: pin across the shoulders of the bind pose.
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        top.push(new THREE.Vector3(lerp(0.21, -0.21, t), 1.52, -0.075));
      }
    }
    const sampleTop = (u, out) => {
      const s = u * (top.length - 1);
      const i = clamp(Math.floor(s), 0, top.length - 2);
      const f = s - i;
      return out.copy(top[i]).lerp(top[i + 1], f);
    };

    /* Measure the pin span so the hem can be widened to an absolute target. */
    let spanMin = 1e9, spanMax = -1e9;
    for (const p of top) { spanMin = Math.min(spanMin, p.x); spanMax = Math.max(spanMax, p.x); }
    const topSpan = Math.max(0.05, spanMax - spanMin);
    const spreadMax = Math.max(1.0, this.width1 / topSpan);

    for (let r = 0; r < ROWS; r++) {
      const v = r / (ROWS - 1);
      const spread = lerp(1.0, spreadMax, v * v * 0.70 + v * 0.30);
      /* Backward bow: the cloak stands off the plate, then falls plumb. Deeper
         than the first pass for two reasons — the backplate now actually has a
         radius to clear, and at the game's 50-55 deg camera pitch a cloak that
         hangs flat against the spine is invisible. The bow is what puts its top
         surface where the camera can see it. */
      const bow = -0.098 * Math.sin(v * Math.PI * 0.80) - 0.030 * v;
      for (let c = 0; c < COLS; c++) {
        const u = c / (COLS - 1);
        sampleTop(u, _v);
        const edge = Math.abs(u * 2 - 1);
        /* Waver the two side edges. A cut piece of cloth hanging from a pin line
           does not have a ruled straight selvedge, and a ruled straight selvedge
           is the single loudest tell that what you are looking at is a simulated
           quad. Only the outer 45% of the width is affected, and the two sides
           are given different phases so the silhouette is not symmetrical. */
        const wob = 1 + 0.088 * Math.sin(v * Math.PI * 2.6 + (u < 0.5 ? 0 : 1.7))
          * smoothstep(0.52, 1.0, edge);
        const cx = _v.x * spread * wob;
        /* Scalloped hem. Baked into the rest *shape*, so the distance
           constraints below preserve it for the life of the sim rather than it
           relaxing out over the first second. */
        const scallop = 1 - 0.105 * (0.5 + 0.5 * Math.cos(u * Math.PI * 5.0))
          - 0.048 * (0.5 + 0.5 * Math.cos(u * Math.PI * 11.0 + 1.7))
          // round the corners off: a rectangular hem is the tell that a cloak
          // is a simulated quad and not a cut piece of cloth
          - 0.26 * smoothstep(0.55, 1.0, edge);
        const cy = _v.y - this.length * v * scallop;
        /* Vertical folds, likewise baked into the rest lengths. A verlet sheet
           whose rest state is planar will stay planar: the constraints have no
           reason to buckle it, which is why the previous pass rendered as a
           flat black rectangle with hard corners despite 154 live particles.
           Two frequencies, both ramping with v, so the drape gathers at the
           shoulders and opens out at the hem — and both are now *skewed* with v
           so the folds run as slightly diagonal channels rather than as a sheet
           of corrugated iron, which is how gravity actually gathers cloth off an
           angled shoulder line. */
        /* Channel *depths* are modulated by a third, non-harmonic frequency.
           Without it every fold is the same width and the same depth, and the
           baked occlusion below then reads as corduroy rather than as cloth.

           Three changes over the previous pass, all of them about making the
           folds survive as *shape*:
            • amplitude 0.116 -> 0.152 m. A 116 mm channel on a 1.18 m hem is
              10 % of the width, and after the solver relaxed it, the visible
              relief was under 30 mm — about 20 screen px at the closeup camera
              and nothing at all at gameplay range.
            • the channels MEANDER. `skew` shifts each fold's phase with v by a
              per-fold amount, so a channel wanders across the sheet as it falls
              instead of running as a straight vertical flute. Straight flutes
              are the corrugated-iron read; real cloth folds migrate because the
              cloth is wider at the hem than at the pin line.
            • a third, low-frequency family (2.6 cycles) carries the *gathers* —
              the two or three big statements a heavy cloak makes — with the 8
              and 13 cycle families riding on top as secondary and tertiary
              creases. Folds at one frequency are a corrugation; folds at three
              nested scales are drapery. */
        const foldAmp = 0.152;
        const vary = 0.76 + 0.36 * Math.sin(u * Math.PI * 5.1 + 1.3);
        const skew = 0.62 * Math.sin(u * Math.PI * 3.3 + 0.4);
        const ramp = 0.10 + 0.90 * v;
        const fold = (
          Math.sin(u * Math.PI * 2.6 - v * 0.55) * (foldAmp * 0.72)
          + Math.sin(u * Math.PI * 8.0 + v * (0.9 + skew)) * foldAmp * vary
          + Math.sin(u * Math.PI * 13.0 + 0.9 - v * (1.3 + skew * 0.7)) * (foldAmp * 0.34)
        ) * ramp;
        const cz = _v.z + bow + fold;
        const i = (r * COLS + c) * 3;
        this.rest[i] = cx; this.rest[i + 1] = cy; this.rest[i + 2] = cz;
        /* Bake the fold occlusion. Real folds only *read* if the light varies
           across them, and inside a crypt the cloak's visible face is usually the
           one turned away from every practical — so it is lit by near-uniform
           ambient and the geometry disappears. Shipped cloth solves this with a
           cached AO term; this is that term, and it costs one float per particle
           and no texture unit. `fold` is signed: positive lays the cloth back
           against the body, so it is the valley, and the valley is what a
           neighbouring fold occludes. */
        const span = foldAmp * (1.40 * vary + 1.06) * ramp;
        this.foldAO[r * COLS + c] = clamp01(0.5 + (0.5 * fold) / Math.max(1e-4, span));
        if (r === 0) this.pinned[r * COLS + c] = 1;
      }
    }
  }

  _buildConstraints() {
    const add = (a, b, stiff) => {
      const ax = this.rest[a * 3], ay = this.rest[a * 3 + 1], az = this.rest[a * 3 + 2];
      const bx = this.rest[b * 3], by = this.rest[b * 3 + 1], bz = this.rest[b * 3 + 2];
      const len = Math.hypot(bx - ax, by - ay, bz - az);
      if (!(len > 1e-5)) return;
      this._cons.push(a, b);
      this._consLen.push(len);
      this._consStiff.push(stiff);
    };
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        if (c + 1 < COLS) add(i, i + 1, this.stiff);                     // structural u
        if (r + 1 < ROWS) add(i, i + COLS, this.stiff);                  // structural v
        if (c + 1 < COLS && r + 1 < ROWS) {                              // shear
          add(i, i + COLS + 1, this.stiff * 0.55);
          add(i + 1, i + COLS, this.stiff * 0.55);
        }
        if (c + 2 < COLS) add(i, i + 2, this.bendStiff);                 // bend u
        if (r + 2 < ROWS) add(i, i + 2 * COLS, this.bendStiff);          // bend v
      }
    }
    this._consLenF = new Float32Array(this._consLen);
    this._consStiffF = new Float32Array(this._consStiff);
    this._consI = new Uint16Array(this._cons);
  }

  _buildMesh() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(this.n * 3);
    const nor = new Float32Array(this.n * 3);
    const uv = new Float32Array(this.n * 2);
    const cv = new Float32Array(this.n);
    const ao = new Float32Array(this.n);
    const uvScale = 0.088;  // metres per texture repeat — a visible wool weave
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const u = c / (COLS - 1), v = r / (ROWS - 1);
        uv[i * 2] = (u * lerp(this.width0, this.width1, v)) / uvScale;
        uv[i * 2 + 1] = (v * this.length) / uvScale;
        cv[i] = v;
        ao[i] = this.foldAO[i];
      }
    }
    const idx = [];
    for (let r = 0; r < ROWS - 1; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aCloakV', new THREE.BufferAttribute(cv, 1));
    geo.setAttribute('aCloakAO', new THREE.BufferAttribute(ao, 1));
    geo.setIndex(idx);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 40);

    let maps = null;
    try {
      maps = this.engine.assets?.pbr?.({ kind: 'cloth', seed: 5309, tiling: 1 }) ?? null;
    } catch (e) { console.warn('[cloak] maps failed —', e?.message ?? e); }

    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0xffffff),
      roughness: 1,
      metalness: 0.02,
      side: THREE.DoubleSide,
      /* Off, deliberately — see the long note in CharacterMesh._material. The
         cloak was the single worst-affected surface in the frame: three's
         `dithering()` writes +/- 0.5/255 into a LINEAR HDR target, and the hem
         sits at ~0.01 scene-linear, so the shift was a 20 % modulation that the
         tonemap's shadow slope then amplified into a visible one-pixel diagonal
         lattice across the whole drape. */
      dithering: false,
      envMapIntensity: 0.26,
      sheen: 0.22,
      sheenRoughness: 0.90,
      sheenColor: new THREE.Color(0x4a5468),
    });
    // Three samplers only: MAX_TEXTURE_IMAGE_UNITS is 16 and cascaded shadows
    // plus the probe volume already claim five. Cloth is a dielectric, so a
    // metalness map is a constant zero, and the ambient occlusion it needs is
    // the drape's own self-shadowing, not a texture.
    if (maps) {
      mat.map = maps.map;
      mat.normalMap = maps.normalMap;
      mat.roughnessMap = maps.roughnessMap;
      mat.metalness = 0.02;
      mat.normalScale.set(1.15, 1.15);
    } else {
      mat.roughness = 0.88;
    }
    mat.name = 'hero_cloak';
    const u = {
      /* Cold slate outside, saturated oxblood lining.
         Two things were wrong before. The lining was desaturated toward the same
         blue-grey as the outer face, and then `uCloakGrade` pushed 50% of the
         *shaded* result toward blue on top of that — so from the front, where the
         camera sees the inside of the drape, the cloak resolved as a flat sheet
         of dusty mauve at 0.13 display luminance: too dark to read as cloth, too
         desaturated to read as a lining, and completely flat. A cloak's inside
         is a different bolt of cloth from its outside, and the red-against-slate
         flash is most of what sells the motion — so the lining keeps its chroma
         and the grade is pulled back to a light balance rather than a repaint. */
      uOuter: { value: new THREE.Vector3(0.94, 1.02, 1.26) },
      /* Pulled back from (2.45, 0.30, 0.27). At that gain, times uCloakAlb 1.90,
         the lining resolved as a near-flat terracotta plate: the red channel
         saturated over most of the visible face, so the fold shading — which
         lives in the *value* of the cloth — had nowhere to go and the drape read
         as fired clay rather than wool. Still an oxblood lining against a slate
         outer face; it just has headroom to shade now. */
      uLining: { value: new THREE.Vector3(1.72, 0.312, 0.278) },
      uCloakHue: { value: new THREE.Vector4(0.930, 1.004, 1.156, 0.90) },
      uCloakAlb: { value: 1.72 },
      uHemDark: { value: 0.34 },
      /* Fold occlusion carries the drape whenever the visible face is turned
         away from the practicals, which behind a front-lit figure is most of the
         time. Raised with the fold amplitude — a 152 mm channel occludes more
         than a 116 mm one — and the roughness half raised with it, because wool
         gathered into the bottom of a channel really is matter there. */
      uFoldAO: { value: new THREE.Vector2(0.58, 0.20) },
      uCloakRim: { value: (() => {
        const c = new THREE.Color(0x6f88bc);
        return new THREE.Vector4(c.r, c.g, c.b, 0.055);
      })() },
      uCloakGrade: { value: new THREE.Vector4(0.940, 1.000, 1.098, 0.24) },
    };
    this._uniforms = u;
    mat.onBeforeCompile = (shader) => {
      for (const k in u) shader.uniforms[k] = u[k];
      shader.vertexShader = 'attribute float aCloakV;\nattribute float aCloakAO;\n'
        + 'varying float vCloakV;\nvarying float vCloakAO;\n'
        + shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\tvCloakV = aCloakV;\n\tvCloakAO = aCloakAO;'
        );
      shader.fragmentShader = CLOAK_FRAG_HEAD + shader.fragmentShader
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>' + CLOAK_FRAG_BODY)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>' + CLOAK_FRAG_EMIT)
        .replace('#include <opaque_fragment>', CLOAK_FRAG_GRADE + '#include <opaque_fragment>');
    };
    mat.customProgramCacheKey = () => 'nona-cloak-v6';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'hero_cloak';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.userData.occluder = false;

    this.geometry = geo;
    this.material = mat;
    this.mesh = mesh;
    this._posAttr = geo.getAttribute('position');
    this._norAttr = geo.getAttribute('normal');
    return mesh;
  }

  /* ------------------------------------------------------------- reset */

  /** Snap the sheet onto its rest shape at the hero's current transform. */
  reset() {
    this._readPins();
    // Build the world-space rest shape by rigidly following the pin line: the
    // top row lands on the pins, and every row below keeps its rig-space offset
    // rotated into the hero's frame.
    const root = this.rig.bones[0];
    if (root) root.updateMatrixWorld(true);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c;
        const o = i * 3;
        if (r === 0) {
          this.pos[o] = this.pinTarget[c * 3];
          this.pos[o + 1] = this.pinTarget[c * 3 + 1];
          this.pos[o + 2] = this.pinTarget[c * 3 + 2];
        } else {
          // offset from the rig-space rest of the pin directly above
          const t0 = (c) * 3;
          const dx = this.rest[o] - this.rest[t0];
          const dy = this.rest[o + 1] - this.rest[t0 + 1];
          const dz = this.rest[o + 2] - this.rest[t0 + 2];
          _v.set(dx, dy, dz).applyQuaternion(this._rootQuat());
          this.pos[o] = this.pinTarget[t0] + _v.x;
          this.pos[o + 1] = this.pinTarget[t0 + 1] + _v.y;
          this.pos[o + 2] = this.pinTarget[t0 + 2] + _v.z;
        }
      }
    }
    this.prev.set(this.pos);
    this._hasPrev = false;
    // Relax so frame 0 is a settled drape, not a flat sheet.
    this._updateColliders();
    for (let k = 0; k < 26; k++) { this._solve(); this._collide(0.4); }
    this._writeMesh();
  }

  _rootQuat() {
    const holder = this.rig.bones[0]?.parent;
    if (holder) { holder.getWorldQuaternion(_qRoot); return _qRoot; }
    return _qRoot.identity();
  }

  /* -------------------------------------------------------------- frame */

  update(dt) {
    if (!this.enabled || !this.mesh) return;
    this._readPins();

    // Teleport guard: if the pin line jumped, carry the whole sheet with it.
    _p.set(this.pinTarget[(COLS >> 1) * 3], this.pinTarget[(COLS >> 1) * 3 + 1], this.pinTarget[(COLS >> 1) * 3 + 2]);
    if (this._hasPrev) {
      const d2 = _p.distanceToSquared(this._anchorPrev);
      if (d2 > 4) {
        _v.subVectors(_p, this._anchorPrev);
        for (let i = 0; i < this.n * 3; i += 3) {
          this.pos[i] += _v.x; this.pos[i + 1] += _v.y; this.pos[i + 2] += _v.z;
          this.prev[i] += _v.x; this.prev[i + 1] += _v.y; this.prev[i + 2] += _v.z;
        }
      }
    }
    this._anchorPrev.copy(_p);
    this._hasPrev = true;

    this._updateColliders();

    const h = dt / SUBSTEPS;
    const h2 = h * h;
    const g = -9.81;
    const wind = this._wind(_w);
    const damp = this.damp;

    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < this.n; i++) {
        const o = i * 3;
        if (this.pinned[i]) {
          const c = (i % COLS) * 3;
          this.pos[o] = this.pinTarget[c];
          this.pos[o + 1] = this.pinTarget[c + 1];
          this.pos[o + 2] = this.pinTarget[c + 2];
          this.prev[o] = this.pos[o]; this.prev[o + 1] = this.pos[o + 1]; this.prev[o + 2] = this.pos[o + 2];
          continue;
        }
        // Row-weighted wind: the hem catches far more air than the shoulders.
        const rw = 0.25 + 0.75 * (Math.floor(i / COLS) / (ROWS - 1));
        const ax = wind.x * rw;
        const ay = g + wind.y * rw * 0.4;
        const az = wind.z * rw;
        const px = this.pos[o], py = this.pos[o + 1], pz = this.pos[o + 2];
        this.pos[o] = px + (px - this.prev[o]) * damp + ax * h2;
        this.pos[o + 1] = py + (py - this.prev[o + 1]) * damp + ay * h2;
        this.pos[o + 2] = pz + (pz - this.prev[o + 2]) * damp + az * h2;
        this.prev[o] = px; this.prev[o + 1] = py; this.prev[o + 2] = pz;
      }
      this._anchorToRest(h);
      this._solve();
      this._collide(1);
    }
    this._writeMesh();
  }

  /**
   * Soft pull toward the *skinned* rest drape.
   *
   * A pure verlet sheet under wind and body drag has no memory of where cloth
   * on a character is supposed to sit: small persistent lateral accelerations
   * integrate into a permanent lean, and the cloak ends up streaming out behind
   * the hero like a banner even at walking pace. Every shipped character cloth
   * solver blends against an authored target for exactly this reason. The pull
   * is strong near the shoulders (where a real cloak is stiffened by its
   * collar) and weak at the hem, so the sim still owns the swing, the lag and
   * the flare — it just cannot drift.
   */
  _anchorToRest(h) {
    const P = this.pos;
    const holder = this.rig.bones[0]?.parent;
    if (!holder) return;
    const q = this._rootQuat();
    const ox = holder.position.x, oy = holder.position.y, oz = holder.position.z;
    const k = 1 - Math.exp(-h / Math.max(1e-4, this.restTau));
    for (let r = 1; r < ROWS; r++) {
      const v = r / (ROWS - 1);
      const w = k * lerp(1.0, this.hemFree, v * v);
      if (w <= 1e-5) continue;
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c, o = i * 3;
        _v.set(this.rest[o], this.rest[o + 1], this.rest[o + 2]).applyQuaternion(q);
        P[o] += (ox + _v.x - P[o]) * w;
        P[o + 1] += (oy + _v.y - P[o + 1]) * w;
        P[o + 2] += (oz + _v.z - P[o + 2]) * w;
      }
    }
  }

  _solve() {
    const I = this._consI, L = this._consLenF, S = this._consStiffF, P = this.pos;
    const nc = L.length;
    for (let it = 0; it < ITER; it++) {
      for (let k = 0; k < nc; k++) {
        const a = I[k * 2], b = I[k * 2 + 1];
        const ao = a * 3, bo = b * 3;
        const dx = P[bo] - P[ao], dy = P[bo + 1] - P[ao + 1], dz = P[bo + 2] - P[ao + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-6) continue;
        const diff = (d - L[k]) / d * S[k];
        const pa = this.pinned[a], pb = this.pinned[b];
        if (pa && pb) continue;
        const wa = pa ? 0 : (pb ? 1 : 0.5);
        const wb = pb ? 0 : (pa ? 1 : 0.5);
        P[ao] += dx * diff * wa; P[ao + 1] += dy * diff * wa; P[ao + 2] += dz * diff * wa;
        P[bo] -= dx * diff * wb; P[bo + 1] -= dy * diff * wb; P[bo + 2] -= dz * diff * wb;
      }
    }
  }

  /**
   * Poly-capsule body collision plus terrain.
   *
   * A single pelvis→neck capsule is not enough: below the pelvis it degenerates
   * into a sphere, and a 0.23 m sphere sitting behind the hips shoves the whole
   * sheet backward every substep until the cloak streams out at 45° like a
   * banner. Three tapered segments (legs → hips → neck) keep the collider the
   * shape the body actually is, and the radii are deliberately a little tighter
   * than the armour so the cloth can sit against the plate.
   */
  _collide(strength) {
    const P = this.pos, pr = this.prev;
    const segs = this._segs;
    const terrain = this.engine.get('terrain');
    const heightAt = terrain && !terrain.__dead && typeof terrain.heightAt === 'function'
      ? terrain.heightAt.bind(terrain) : null;

    for (let i = 0; i < this.n; i++) {
      if (this.pinned[i]) continue;
      const o = i * 3;
      for (let k = 0; k < segs.length; k++) {
        const S = segs[k];
        _seg.subVectors(S.b, S.a);
        const len2 = Math.max(1e-6, _seg.lengthSq());
        _rel.set(P[o] - S.a.x, P[o + 1] - S.a.y, P[o + 2] - S.a.z);
        let t = _rel.dot(_seg) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        _v.copy(S.a).addScaledVector(_seg, t);
        _rel.set(P[o] - _v.x, P[o + 1] - _v.y, P[o + 2] - _v.z);
        const d = _rel.length();
        const rr = lerp(S.ra, S.rb, t);
        if (d < rr && d > 1e-5) {
          _rel.multiplyScalar(((rr - d) * strength) / d);
          P[o] += _rel.x; P[o + 1] += _rel.y; P[o + 2] += _rel.z;
          // friction: kill the tangential slide so cloth grips plate
          pr[o] = lerp(pr[o], P[o], 0.26);
          pr[o + 1] = lerp(pr[o + 1], P[o + 1], 0.26);
          pr[o + 2] = lerp(pr[o + 2], P[o + 2], 0.26);
        }
      }
      if (heightAt) {
        const gy = heightAt(P[o], P[o + 2]) + 0.012;
        if (P[o + 1] < gy) {
          P[o + 1] = gy;
          pr[o] = lerp(pr[o], P[o], 0.55);
          pr[o + 2] = lerp(pr[o + 2], P[o + 2], 0.55);
        }
      }
    }
  }

  _updateColliders() {
    /* Radii are the *depth* of the armoured torso (~0.15 m behind the spine),
       not its width (~0.21 m): the collider is round and the body is not, and
       sizing it to the width would shove the cloak a hand's breadth off the
       back permanently. Sized to the depth it grips the backplate instead. */
    const segs = this._segs ??= [
      { a: new THREE.Vector3(), b: new THREE.Vector3(), ra: 0.135, rb: 0.170 },  // legs -> hips
      { a: new THREE.Vector3(), b: new THREE.Vector3(), ra: 0.170, rb: 0.162 },  // hips -> chest
      { a: new THREE.Vector3(), b: new THREE.Vector3(), ra: 0.162, rb: 0.140 },  // chest -> neck
    ];
    const pelvis = this.rig.bone('pelvis');
    const spine2 = this.rig.bone('spine2');
    const neck = this.rig.bone('neck') ?? this.rig.bone('spine3');
    if (pelvis) { pelvis.updateWorldMatrix(true, false); this._capA.setFromMatrixPosition(pelvis.matrixWorld); }
    if (neck) { neck.updateWorldMatrix(true, false); this._capB.setFromMatrixPosition(neck.matrixWorld); }
    _v.copy(this._capA);
    if (spine2) { spine2.updateWorldMatrix(true, false); _p.setFromMatrixPosition(spine2.matrixWorld); }
    else _p.copy(this._capA).lerp(this._capB, 0.5);

    segs[0].a.set(_v.x, _v.y - 0.46, _v.z);
    segs[0].b.copy(_v);
    segs[1].a.copy(_v);
    segs[1].b.copy(_p);
    segs[2].a.copy(_p);
    segs[2].b.copy(this._capB);
    this._hip.copy(this._capA);
  }

  _readPins() {
    const n = this.anchors?.length ?? 0;
    if (!n) {
      // fall back to the shoulder line of whatever the rig currently is
      const s = this.rig.bone('spine3');
      if (s) s.updateWorldMatrix(true, false);
      for (let c = 0; c < COLS; c++) {
        const u = c / (COLS - 1);
        _v.set(lerp(0.21, -0.21, u), 1.52, -0.075);
        if (s) _v.applyMatrix4(s.matrixWorld);
        this.pinTarget[c * 3] = _v.x; this.pinTarget[c * 3 + 1] = _v.y; this.pinTarget[c * 3 + 2] = _v.z;
      }
      return;
    }
    const wp = [];
    for (let k = 0; k < n; k++) {
      const a = this.anchors[k];
      const bone = this.rig.bone(a.bone);
      if (bone) {
        bone.updateWorldMatrix(true, false);
        _v.copy(a.offset).applyMatrix4(bone.matrixWorld);
      } else {
        _v.copy(a.offset);
      }
      wp.push(_v.clone());
    }
    for (let c = 0; c < COLS; c++) {
      const s = (c / (COLS - 1)) * (n - 1);
      const i = clamp(Math.floor(s), 0, n - 2);
      const f = s - i;
      _v.copy(wp[i]).lerp(wp[i + 1], f);
      this.pinTarget[c * 3] = _v.x;
      this.pinTarget[c * 3 + 1] = _v.y;
      this.pinTarget[c * 3 + 2] = _v.z;
    }
  }

  _wind(out) {
    out.set(0, 0, 0);
    try {
      const w = this.engine.get('weather');
      if (w && !w.__dead && typeof w.windAt === 'function') {
        _p.set(this._anchorPrev.x, this._anchorPrev.y, this._anchorPrev.z);
        w.windAt(_p, this.engine.clock.elapsed, out);
        out.multiplyScalar(this.windGain);
        const wm = out.length();
        if (wm > this.maxWind) out.multiplyScalar(this.maxWind / wm);
      }
    } catch { out.set(0, 0, 0); }
    // Motion drag: sweeping the cloak through air pushes it backward. Fed by
    // the hero module through `setDrag`, which already has the velocity.
    out.x += this._dragX ?? 0;
    out.y += this._dragY ?? 0;
    out.z += this._dragZ ?? 0;
    // Hard-cap the total: gravity is 9.81, so anything approaching that would
    // hold the sheet out horizontally.
    const m = out.length();
    if (m > this.maxAccel) out.multiplyScalar(this.maxAccel / m);
    return out;
  }

  /** Hero hands us its velocity so the cloak trails properly. */
  setDrag(vx, vy, vz, gain = 1.35) {
    const sp = Math.hypot(vx, vz);
    const k = gain * (0.55 + 0.45 * clamp01(sp / 5));
    this._dragX = -vx * k;
    this._dragY = -vy * k * 0.3 + clamp01(sp / 5) * 0.9;
    this._dragZ = -vz * k;
  }

  _writeMesh() {
    const pa = this._posAttr.array;
    pa.set(this.pos);
    this._posAttr.needsUpdate = true;

    /* normals: cross of the parametric differences, accumulated per vertex */
    const na = this._norAttr.array;
    na.fill(0);
    const P = this.pos;
    for (let r = 0; r < ROWS - 1; r++) {
      for (let c = 0; c < COLS - 1; c++) {
        const a = (r * COLS + c) * 3, b = a + 3, d = ((r + 1) * COLS + c) * 3, e = d + 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
        // Negated: u runs from the hero's left shoulder to the right and v runs
        // downward, so u×v points *into* the back. The triangle winding already
        // faces outward, and a shading normal that disagreed with it lit the
        // whole cloak from behind and showed the lining on the outside.
        const nx = -(uy * vz - uz * vy), ny = -(uz * vx - ux * vz), nz = -(ux * vy - uy * vx);
        for (const k of [a, b, d, e]) { na[k] += nx; na[k + 1] += ny; na[k + 2] += nz; }
      }
    }
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const l = Math.hypot(na[o], na[o + 1], na[o + 2]) || 1;
      na[o] /= l; na[o + 1] /= l; na[o + 2] /= l;
    }
    this._norAttr.needsUpdate = true;
  }

  dispose() {
    try { this.mesh?.parent?.remove(this.mesh); } catch { /* ignore */ }
    try { this.geometry?.dispose(); } catch { /* ignore */ }
    try { this.material?.dispose(); } catch { /* ignore */ }
    this.mesh = null;
  }
}

const _qRoot = new THREE.Quaternion();
export { COLS as CLOAK_COLS, ROWS as CLOAK_ROWS };
