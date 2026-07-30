/**
 * THE NINTH VIGIL — shrines, and the only geometry the Director owns.
 *
 * A shrine is an interactable site that grants a timed blessing. It has to *read*
 * as a thing in the world, not as a trigger volume, so each one is:
 *
 *   • a bevelled stone plinth (base + shaft + capital, merged, instanced)
 *   • a floating rune crystal that is the only emissive thing on it
 *   • an engraved floor sigil that lights up when the shrine is charged
 *   • one real point light, so the plinth is lit by its own rune rather than
 *     reading as a black silhouette under a glowing orb
 *
 * The same instanced sigil pool also draws the horde-event ring and the boss
 * phase ring, which is why they live here: one geometry, one material, one draw
 * call for every ground rune in the game.
 *
 * Cost: **4 draw calls** total (plinth, rune crystal, floor sigils, light
 * shafts) and **1 non-shadow point light**, independent of how many shrines or
 * rings are on screen. The light is allocated at init and never after, so the
 * light count is fixed before the first shader compiles; it costs no texture
 * unit because it does not cast shadows. Nothing is allocated per frame —
 * instance matrices are rewritten in place.
 *
 * Determinism: geometry seeds and buff selection come from `engine.freshRand`,
 * animation from `engine.clock.elapsed`.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const MAX_SHRINES = 4;
const MAX_SIGILS = MAX_SHRINES + 2;   // + wave ring + boss ring
const REACH = 2.35;                    // metres at which a shrine is touchable
const IDLE_GLOW = 0.46;                // an unclaimed shrine's resting brightness

/**
 * The blessings. Deliberately few and deliberately readable — a player must be
 * able to tell what they picked up from the colour of the light alone.
 */
export const BLESSINGS = [
  {
    id: 'shrine.conduit', label: 'Conduit', colour: 0x9b6cff, kelvin: 8200,
    duration: 45, mods: { damage: 0.35 },
    text: 'Conduit — your strikes carry the arc',
  },
  {
    id: 'shrine.lethal', label: 'Lethal', colour: 0xff5a3c, kelvin: 2400,
    duration: 40, mods: { critChance: 0.18, damage: 0.10 },
    text: 'Lethal — the blade finds the seam',
  },
  {
    id: 'shrine.aegis', label: 'Aegis', colour: 0x63c6ff, kelvin: 9000,
    duration: 50, mods: { armour: 0.45 },
    text: 'Aegis — stone answers for you',
  },
  {
    id: 'shrine.blessed', label: 'Blessed', colour: 0xffd27a, kelvin: 3000,
    duration: 60, mods: { maxHealth: 0.22 }, heal: true,
    text: 'Blessed — the wound closes',
  },
  {
    id: 'shrine.fleet', label: 'Fleet', colour: 0x7cf0c0, kelvin: 7000,
    duration: 35, mods: { moveSpeed: 0.24 },
    text: 'Fleet — the dark cannot keep pace',
  },
];

export class Shrines {
  /**
   * @param {import('../../core/Engine.js').Engine} engine
   * @param {import('./WorldState.js').WorldState} world
   */
  constructor(engine, world) {
    this.engine = engine;
    this.world = world;

    this.group = new THREE.Group();
    this.group.name = 'director.shrines';
    this.group.matrixAutoUpdate = false;

    /** @type {Array<object>} */ this.sites = [];
    /** Ground sigils: shrine discs + the wave ring + the boss ring. */
    this._sigils = [];
    this._waveRing = null;
    this._bossRing = null;

    this.plinthMesh = null;
    this.runeMesh = null;
    this.sigilMesh = null;
    this.shaftMesh = null;
    this.drawCalls = 0;
    this.ready = false;
    this.posed = false;

    this._mats = [];
    this._geos = [];
    this._torches = [];
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._col = new THREE.Color();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    /** Where the player enters — no shrine may stand on the hero's mark. */
    this._entry = { x: 0, z: 0 };
  }

  /* ================================================================ *
   * build
   * ================================================================ */

  async init() {
    try {
      const rand = this.engine.freshRand('director:shrines');

      /* ---------- plinth: base + shaft + capital, all bevelled ---------- */
      const parts = [];
      const base = new RoundedBoxGeometry(0.96, 0.30, 0.96, 2, 0.055);
      base.translate(0, 0.15, 0);
      parts.push(base);
      const step = new RoundedBoxGeometry(0.74, 0.20, 0.74, 2, 0.045);
      step.translate(0, 0.40, 0);
      parts.push(step);
      const shaft = new RoundedBoxGeometry(0.46, 0.86, 0.46, 2, 0.04);
      shaft.translate(0, 0.93, 0);
      parts.push(shaft);
      const cap = new RoundedBoxGeometry(0.66, 0.14, 0.66, 2, 0.038);
      cap.translate(0, 1.43, 0);
      parts.push(cap);
      // a broken corner on the capital: nothing down here is intact
      const chip = new RoundedBoxGeometry(0.19, 0.13, 0.19, 1, 0.03);
      chip.translate(0.30, 1.50, -0.26);
      chip.rotateZ(0.22);
      parts.push(chip);
      const plinthGeo = mergeGeometries(parts, false) ?? base;
      for (const p of parts) if (p !== plinthGeo) p.dispose();
      this._geos.push(plinthGeo);

      const stoneMat = this._stoneMaterial();
      this.plinthMesh = new THREE.InstancedMesh(plinthGeo, stoneMat, MAX_SHRINES);
      this.plinthMesh.name = 'shrine.plinth';
      this.plinthMesh.castShadow = true;
      this.plinthMesh.receiveShadow = true;
      this.plinthMesh.frustumCulled = false;
      this.plinthMesh.count = 0;
      this.plinthMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.plinthMesh);

      /* ---------- the rune stone: the emissive read ----------
         A bipyramid, not a sphere, so the silhouette is a *crystal* and not the
         camera-facing dot that reads as lens dirt. Value structure is baked into
         vertex colours — bright at the tips, deep at the waist — because an
         unlit body with a single flat colour is exactly what blows out to white
         under bloom. */
      const runeGeo = new THREE.OctahedronGeometry(0.155, 0);
      runeGeo.scale(1.0, 2.25, 0.72);
      bakeGemGradient(runeGeo);
      this._geos.push(runeGeo);
      /* Unlit on purpose. `instanceColor` multiplies `diffuseColor` in the
         fragment shader, which is the only per-instance channel three exposes
         without a custom shader — and on a self-lit rune that channel *is* the
         emission. The baked vertex colours give it internal structure so only
         the tips cross the bloom threshold. */
      const runeMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, toneMapped: true, vertexColors: true,
      });
      this._mats.push(runeMat);
      this.runeMesh = new THREE.InstancedMesh(runeGeo, runeMat, MAX_SHRINES);
      this.runeMesh.name = 'shrine.rune';
      this.runeMesh.castShadow = false;
      this.runeMesh.frustumCulled = false;
      this.runeMesh.count = 0;
      this.runeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.runeMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHRINES * 3).fill(1), 3);
      this.runeMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.runeMesh);

      /* ---------- ground sigils (shrines + wave ring + boss ring) ------- */
      const sigilTex = this._makeSigilTexture(rand);
      const sigilGeo = new THREE.PlaneGeometry(1, 1, 1, 1);
      sigilGeo.rotateX(-Math.PI * 0.5);
      this._geos.push(sigilGeo);
      const sigilMat = new THREE.MeshBasicMaterial({
        map: sigilTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
      });
      this._mats.push(sigilMat);
      this.sigilMesh = new THREE.InstancedMesh(sigilGeo, sigilMat, MAX_SIGILS);
      this.sigilMesh.name = 'shrine.sigil';
      this.sigilMesh.frustumCulled = false;
      this.sigilMesh.renderOrder = 6;
      this.sigilMesh.count = 0;
      this.sigilMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.sigilMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SIGILS * 3).fill(1), 3);
      this.sigilMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.sigilMesh);

      /* ---------- the shaft: faint haze over a charged shrine ----------
         Deliberately barely-there. A bright cylinder over a shrine reads as a
         solid cone of plastic, which is the "billboard blob" fail; at this
         opacity, back faces only, it reads as dust catching the rune light and
         nothing else. */
      const shaftTex = this._makeShaftTexture(rand);
      const shaftGeo = new THREE.CylinderGeometry(0.20, 0.44, 2.4, 14, 1, true);
      shaftGeo.translate(0, 1.20, 0);
      this._geos.push(shaftGeo);
      const shaftMat = new THREE.MeshBasicMaterial({
        map: shaftTex, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.BackSide, toneMapped: true, opacity: 0.15,
      });
      this._mats.push(shaftMat);
      this.shaftMesh = new THREE.InstancedMesh(shaftGeo, shaftMat, MAX_SHRINES);
      this.shaftMesh.name = 'shrine.shaft';
      this.shaftMesh.frustumCulled = false;
      this.shaftMesh.renderOrder = 7;
      this.shaftMesh.count = 0;
      this.shaftMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.shaftMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SHRINES * 3).fill(1), 3);
      this.shaftMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this.shaftMesh);

      /* ---------- the shrine's own light ----------
         Lighting's practical pool is importance-ranked and a crypt already has
         ~20 braziers competing for its slots, so a pooled shrine light loses and
         the plinth renders as an unlit black silhouette under its own glowing
         rune. A shrine that does not light its own stone is the "floating
         glowing orb" defect from KNOWN_ISSUES, so this module owns exactly one
         point light and hands it to whichever shrine matters most this frame.
         Allocated at init and never added later, so the light count — and
         therefore every shader permutation — is fixed before first compile. */
      this.light = new THREE.PointLight(0xffffff, 0, 13, 2);
      this.light.name = 'shrine.key';
      this.light.castShadow = false;      // costs no texture unit
      this.group.add(this.light);
      this._lightOwner = -1;

      this.engine.scene.add(this.group);
      this.drawCalls = 4;
      this.ready = true;

      /* cascaded shadows + probe bounce on the only lit surface we own */
      try {
        const lighting = this.engine.get('lighting');
        if (lighting?.registerMaterials) lighting.registerMaterials([stoneMat]);
        else this.engine.bus.emit('lighting:register', { materials: [stoneMat] });
      } catch { /* lighting optional */ }
    } catch (e) {
      this.ready = false;
      console.error('[director:shrines] build failed —', e);
    }
  }

  _stoneMaterial() {
    try {
      const mat = this.engine.assets?.material?.({
        kind: 'stone', seed: 4471, tiling: 3.2, size: 512,
        roughness: 1, metalness: 1,
      });
      if (mat) return mat;
    } catch { /* fall through */ }
    const fallback = new THREE.MeshStandardMaterial({ color: 0x6a6560, roughness: 0.82, metalness: 0.04 });
    this._mats.push(fallback);
    return fallback;
  }

  /* ---------------------------------------------------- textures */

  /**
   * The floor sigil.
   *
   * THE DEFECT THIS REPLACES: every stroke was a single `rgba(255,255,255,0.96)`
   * line of constant width on a geometrically perfect circle, drawn additively.
   * That is 1-bit line art by construction. Composited over stone at near-full
   * alpha it erased the flagstones under it, it clipped, and it was the brightest
   * element in the boss and combat frames — it read as a debug gizmo, not as a
   * ward cut into a floor.
   *
   * Now every stroke is an ENGRAVED CHANNEL, built in three coupled passes:
   *
   *   1. a WIDE dim pass — the light spilling out of the groove onto the stone,
   *   2. a NARROW `destination-out` pass down the same path, which carves the
   *      shadowed core out of the middle of it. What survives is a pair of soft
   *      lips with a dark centre: exactly what a lit channel in stone looks like,
   *      and nothing anywhere in it is a clean 1-px edge,
   *   3. a per-pixel erosion + charge field multiplied into alpha, so the channel
   *      is pitted, chipped clean through in places, and whole arcs of it are
   *      cold while others are charged.
   *
   * The peak alpha is 0.62, not 0.96, and the strokes' own colour is scaled down
   * hard at the instance level (see `sync`) because the grade pass lifts midtones
   * by roughly 3x.
   */
  _makeSigilTexture(rand) {
    const S = 256;
    const cv = this._canvas(S, S);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, S, S);
    const c = S * 0.5;

    /* soft inner bloom — this is the light *pooling* on the flagstones. Kept, but
       at half weight: at the old 0.40 it was itself a visible bright disc. */
    const grd = g.createRadialGradient(c, c, 0, c, c, S * 0.5);
    grd.addColorStop(0.00, 'rgba(255,255,255,0.19)');
    grd.addColorStop(0.18, 'rgba(255,255,255,0.11)');
    grd.addColorStop(0.42, 'rgba(255,255,255,0.055)');
    grd.addColorStop(0.74, 'rgba(255,255,255,0.020)');
    grd.addColorStop(1.00, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);

    g.lineCap = 'butt';

    /* Every stroke is drawn twice: a wide soft lip, then a narrow carve straight
       back out of its middle. `mode` selects which. */
    const LIP = 0, CORE = 1;
    const setMode = (mode, alpha) => {
      if (mode === LIP) {
        g.globalCompositeOperation = 'source-over';
        g.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        g.fillStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
      } else {
        g.globalCompositeOperation = 'destination-out';
        g.strokeStyle = 'rgba(0,0,0,0.88)';
        g.fillStyle = 'rgba(0,0,0,0.88)';
      }
    };

    /* outer + inner rings, each broken in a couple of places, and each wandering
       off a true circle by a couple of pixels so no arc is analytically perfect */
    const ring = (r, w, gaps, phase, mode) => {
      g.lineWidth = w;
      const seg = 96;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2 + phase;
        const a1 = ((i + 0.92) / seg) * Math.PI * 2 + phase;
        let skip = false;
        for (const gp of gaps) {
          const d = Math.abs(((a0 - gp + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
          if (d > Math.PI - 0.16) skip = true;
        }
        if (skip) continue;
        const wob = 1 + 0.014 * Math.sin(a0 * 3.0 + phase * 5.1)
          + 0.008 * Math.sin(a0 * 7.0 - phase * 2.3);
        g.beginPath();
        g.arc(c, c, r * wob, a0, a1);
        g.stroke();
      }
      void mode;
    };
    /* Line widths are set for a 2.75 m disc seen from ~26 m. The lip pass is
       1.7x the nominal channel width and the carve is 0.5x, so the visible pair
       of lips lands at ~3 screen px each — wide enough to survive the TAA resolve
       without shimmering, soft enough never to read as a vector stroke. */
    const RINGS = [
      [S * 0.455, 6.0, [0.4, 3.1, 4.9], 0.0],
      [S * 0.392, 3.6, [1.7, 4.4], 0.6],
      [S * 0.215, 4.4, [2.6, 5.5], 0.3],
    ];
    const TICKS = 36;
    const tickJit = [];
    for (let i = 0; i < TICKS; i++) tickJit.push(rand() * 0.02);
    const CHORDS = 24;
    const chordJit = [];
    for (let i = 0; i < CHORDS; i++) {
      chordJit.push([(rand() - 0.5) * 0.30, 0.30 + rand() * 0.42, rand() < 0.45]);
    }

    for (const mode of [LIP, CORE]) {
      const wk = mode === LIP ? 1.70 : 0.50;

      setMode(mode, 0.62);
      for (const [r, w, gaps, phase] of RINGS) ring(r, w * wk, gaps, phase, mode);

      /* radial ticks — long/short alternating, jittered so it is not a clock face */
      for (let i = 0; i < TICKS; i++) {
        const a = (i / TICKS) * Math.PI * 2 + tickJit[i];
        const long = i % 3 === 0;
        const r0 = S * (long ? 0.398 : 0.418);
        const r1 = S * (long ? 0.452 : 0.446);
        g.lineWidth = (long ? 5.5 : 3.2) * wk;
        setMode(mode, long ? 0.60 : 0.36);
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        g.lineTo(c + Math.cos(a) * r1, c + Math.sin(a) * r1);
        g.stroke();
      }

      /* glyph band: short chords between the two inner rings */
      g.lineWidth = 4.0 * wk;
      for (let i = 0; i < CHORDS; i++) {
        const a = (i / CHORDS) * Math.PI * 2 + 0.13;
        const r0 = S * 0.235, r1 = S * 0.376;
        const [bend, alpha, hook] = chordJit[i];
        setMode(mode, alpha * 0.72);
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        g.lineTo(c + Math.cos(a + bend) * r1, c + Math.sin(a + bend) * r1);
        if (hook) {
          const a2 = a + bend;
          g.lineTo(c + Math.cos(a2 + 0.10) * (r1 - S * 0.045), c + Math.sin(a2 + 0.10) * (r1 - S * 0.045));
        }
        g.stroke();
      }

      /* the eye: a diamond at the centre, where the plinth stands. Outlined by
         the same lip/carve pair, so it is a bezel and not a solid white lozenge —
         a filled shape here was the single brightest pixel cluster in the frame. */
      setMode(mode, 0.56);
      const dia = (k) => {
        g.beginPath();
        g.moveTo(c, c - S * 0.082 * k);
        g.lineTo(c + S * 0.055 * k, c);
        g.lineTo(c, c + S * 0.082 * k);
        g.lineTo(c - S * 0.055 * k, c);
        g.closePath();
        g.fill();
      };
      dia(mode === LIP ? 1.0 : 0.66);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;

    /* --- erosion + charge, per pixel ---------------------------------------
       Deterministic hash noise, no PRNG draws, so the texture is byte-identical
       every run. Three frequencies: chips that break the channel clean through,
       grain that stops any run being uniform, and a slow charge field so entire
       arcs of the ward are cold. */
    const hash2 = (xi, yi, sd) => {
      let h = xi * 374761393 + yi * 668265263 + sd * 2147483647;
      h = (h ^ (h >>> 13)) * 1274126177;
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    };
    const smooth = (t) => t * t * (3 - 2 * t);
    const vn = (x, y, sd) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const u = smooth(x - xi), v = smooth(y - yi);
      const a = hash2(xi, yi, sd), b = hash2(xi + 1, yi, sd);
      const d = hash2(xi, yi + 1, sd), e = hash2(xi + 1, yi + 1, sd);
      return (a + (b - a) * u) + ((d + (e - d) * u) - (a + (b - a) * u)) * v;
    };
    const img = g.getImageData(0, 0, S, S);
    const px = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const o = (y * S + x) * 4;
        if (px[o + 3] === 0) continue;
        const grain = vn(x * 0.135, y * 0.135, 17) * 0.62 + vn(x * 0.46, y * 0.46, 91) * 0.38;
        const chip = vn(x * 0.075, y * 0.075, 233);
        const chg = vn(x * 0.0155, y * 0.0155, 401);
        let k = 0.30 + 1.05 * grain;
        k *= 1 - Math.max(0, 1 - Math.abs(chip - 0.5) * 7.5) * 0.55;
        k *= 0.30 + 1.05 * smooth(Math.max(0, Math.min(1, (chg - 0.30) / 0.42)));
        px[o + 3] = Math.max(0, Math.min(255, px[o + 3] * Math.max(0, Math.min(1.15, k))));
      }
    }
    g.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.engine.maxAniso ?? 1;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this._texs = this._texs ?? [];
    this._texs.push(tex);
    return tex;
  }

  /** Vertical falloff for the light shaft: bright at the base, gone at the top. */
  _makeShaftTexture(rand) {
    const W = 64, H = 128;
    const cv = this._canvas(W, H);
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y++) {
      const v = y / (H - 1);
      // y = 0 is the top of the cylinder in UV space
      const vert = Math.pow(v, 1.7) * (1 - Math.pow(1 - v, 6));
      for (let x = 0; x < W; x++) {
        const u = x / (W - 1);
        // banded striation so it reads as light through dust, not a gradient
        const band = 0.72 + 0.28 * Math.sin(u * Math.PI * 6 + rand() * 0.001);
        const a = clamp01(vert * band) * 0.9;
        g.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        g.fillRect(x, y, 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    this._texs = this._texs ?? [];
    this._texs.push(tex);
    return tex;
  }

  _canvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
  }

  /* ================================================================ *
   * placement
   * ================================================================ */

  /**
   * Choose shrine sites for this scenario. Shrine-kind encounters get one; the
   * hub gets one in the plaza; a combat frame gets one at the hall edge so the
   * composition has a cool accent against the warm firelight.
   */
  place(name, cfg, plan) {
    if (!this.ready) return;
    this._releaseTorches();
    this.sites.length = 0;
    this._waveRing = null;
    this._bossRing = null;

    const rand = this.engine.freshRand(`shrines:${name}:${this.world.depth}`);
    const slots = this._enemySlots();
    this._entry.x = plan?._entry?.x ?? 0;
    this._entry.z = plan?._entry?.z ?? 0;

    const wanted = [];
    for (const enc of plan?.list ?? []) {
      if (enc.kind === 'shrine' || enc.kind === 'guard') wanted.push(enc.room);
    }
    if (name === 'combat' || name === 'dungeon' || name === 'night' || name === 'overworld') {
      const hall = plan?.rooms?.find((r) => r.grand) ?? plan?.rooms?.[0];
      if (hall) wanted.unshift(hall);
    }
    if (name === 'hub' || name === 'inventory') {
      const t = cfg?.camera?.target ?? [0, 0, 0];
      wanted.push({ cx: (t[0] ?? 0) + 5.5, cz: (t[2] ?? 0) - 4.0, w: 10, d: 10, minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9, id: -2, kind: 'plaza' });
    }

    let placed = 0;
    for (const room of wanted) {
      if (placed >= MAX_SHRINES - 1) break;   // keep one sigil slot for the rings
      if (!room) continue;
      const spot = this._siteIn(room, slots, rand);
      if (!spot) continue;
      const b = BLESSINGS[Math.floor(rand() * BLESSINGS.length) % BLESSINGS.length];
      this.sites.push({
        id: `shrine:${this.world.depth}:${room.id}:${placed}`,
        x: spot.x, y: spot.y, z: spot.z,
        yaw: rand() * Math.PI * 2,
        roomId: room.id,
        blessing: b,
        state: 'ready',              // ready | spent
        charge: IDLE_GLOW,           // 0..1 visual charge
        pulse: rand() * 6.28,
        usedAt: -99,
      });
      placed++;
    }

    for (const s of this.sites) {
      /* keep pathing off the plinth */
      try { this.engine.bus.emit('ai:obstacle', { x: s.x, z: s.z, r: 0.78, blocked: true }); } catch { /* noop */ }
      /* let anything that dresses or lights the world know a fixture exists */
      try {
        this.engine.bus.emit('director:shrine:placed', {
          id: s.id, x: s.x, y: s.y, z: s.z, colour: s.blessing.colour, blessing: s.blessing.id,
        });
      } catch { /* noop */ }
    }

    this._lightOwner = -1;
    this._writeStatic();
  }

  /**
   * Pick a site inside a room.
   *
   * Placement is composition, not a free square of floor. Three rules, in order
   * of how badly breaking them hurts the frame:
   *
   *  1. **Never on the player's mark or in the middle of the arena.** A plinth at
   *     the centre of the hall stands exactly where the fight happens, blocks the
   *     hero's silhouette, and reads as a level-design mistake.
   *  2. **Against the architecture, not inside it.** The good band is roughly
   *     two-thirds out from the centre: close enough to a wall or an arcade to
   *     compose against it, far enough that the plinth is not wedged into a
   *     column. Clearance is the test for both ends of that.
   *  3. **Reachable.** A ring probe, not a point probe, so the player can
   *     actually walk up and touch it.
   */
  _siteIn(room, slots, rand) {
    const half = Math.max(2.5, Math.min(room.w, room.d) * 0.5);
    const target = half * 0.68;
    const minR = Math.min(half * 0.34, 5.0);
    const ex = this._entry.x, ez = this._entry.z;

    const score = (x, z) => {
      const dCentre = Math.hypot(x - room.cx, z - room.cz);
      if (dCentre < minR) return -1;
      if (Math.hypot(x - ex, z - ez) < 5.0) return -1;     // rule 1
      if (!this._siteClear(x, z)) return -1;               // rule 3
      const clear = this._clearance(x, z);
      // rule 2: 1.6–3.4 m of clearance is "beside a wall"; wide open is worse.
      const band = clear < 1.5 ? clear / 1.5 : clear > 3.6 ? Math.max(0.25, 3.6 / clear) : 1;
      return band * (1 - Math.min(1, Math.abs(dCentre - target) / half));
    };

    let best = null, bestScore = 0;
    for (const p of slots) {
      if (p.x < room.minX - 0.5 || p.x > room.maxX + 0.5) continue;
      if (p.z < room.minZ - 0.5 || p.z > room.maxZ + 0.5) continue;
      const sc = score(p.x, p.z);
      if (sc > bestScore) { bestScore = sc; best = { x: p.x, z: p.z }; }
    }
    /* Seeded fallback scatter — a room with no usable slot of its own still gets
       a shrine rather than silently losing one. */
    for (let i = 0; i < 80; i++) {
      const a = rand() * Math.PI * 2;
      const r = half * (0.45 + rand() * 0.48);
      const x = room.cx + Math.cos(a) * r, z = room.cz + Math.sin(a) * r;
      const sc = score(x, z);
      if (sc > bestScore) { bestScore = sc; best = { x, z }; }
    }
    return best ? { x: best.x, y: this._floorAt(best.x, best.z), z: best.z } : null;
  }

  /** Centre + an eight-point ring at 0.85 m must all be standable floor. */
  _siteClear(x, z) {
    if (!this._standable(x, z, 1.05)) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (!this._standable(x + Math.cos(a) * 0.85, z + Math.sin(a) * 0.85, 0.42)) return false;
    }
    return true;
  }

  _clearance(x, z) {
    const d = this.engine.get('dungeon');
    if (!d || d.__dead || !d.active || typeof d.clearanceAt !== 'function') return 2.0;
    try { const c = d.clearanceAt(x, z); return Number.isFinite(c) ? c : 2.0; } catch { return 2.0; }
  }

  _enemySlots() {
    const d = this.engine.get('dungeon');
    if (!d || d.__dead || typeof d.spawnPoints !== 'function') return [];
    try { return (d.spawnPoints('enemy') ?? []).map((p) => ({ x: p.x, z: p.z })); } catch { return []; }
  }

  /* ================================================================ *
   * interaction
   * ================================================================ */

  tick(dt, elapsed, hero, director) {
    if (!this.ready || !this.sites.length) return;
    /* A capture frame holds whatever charge the scenario posed — the light is
       part of the composition there, not a proximity affordance. */
    if (this.posed) return;
    for (const s of this.sites) {
      const d = Math.hypot(s.x - hero.x, s.z - hero.z);
      if (s.state === 'ready') {
        /* An unclaimed shrine is never dark — it has to be findable across a
           room. Approaching brings it up to full, which is the affordance. */
        const near = IDLE_GLOW + (1 - IDLE_GLOW) * clamp01(1 - (d - REACH) / 7.5);
        s.charge = s.charge + (near - s.charge) * clamp01(dt * 3.0);
        if (d <= REACH) this._activate(s, elapsed, director);
      } else {
        s.charge += (0 - s.charge) * clamp01(dt * 1.4);
      }
    }
  }

  /**
   * Pose every shrine at a fixed charge (scenario setup). `posed` then freezes
   * proximity logic so a captured frame is stable and repeatable.
   */
  poseCharged(charge = 1, posed = true) {
    this.posed = !!posed;
    for (const s of this.sites) s.charge = clamp01(charge);
  }

  activateNearest(hero, director, force = false) {
    let best = null, bd = 1e9;
    for (const s of this.sites) {
      if (s.state !== 'ready') continue;
      const d = Math.hypot(s.x - hero.x, s.z - hero.z);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return null;
    if (!force && bd > REACH * 2.5) return null;
    return this._activate(best, this.engine.clock.elapsed, director);
  }

  _activate(s, elapsed, director) {
    if (s.state !== 'ready') return null;
    s.state = 'spent';
    s.usedAt = elapsed;
    s.charge = 1;
    const b = s.blessing;
    this.world.shrinesUsed++;
    this.world.touch();

    director?.grantBuff?.({
      id: b.id, label: b.label, colour: b.colour,
      duration: b.duration * (1 + (this.world.tierIndex - 1) * 0.06),
      mods: b.mods,
    });
    if (b.heal) {
      const hero = this.engine.get('hero');
      try {
        if (hero && typeof hero.heal === 'function') hero.heal(hero.stats?.maxHealth ?? 999);
        else if (hero?.stats) hero.stats.health = hero.stats.maxHealth;
      } catch { /* hero optional */ }
    }

    const bus = this.engine.bus;
    bus.emit('ui:toast', { text: b.text, tier: 'good' });
    bus.emit('audio:sfx', { id: 'shrine.activate', gain: 1, pitch: 1 });
    bus.emit('audio:cue', { id: 'shrine.hum', gain: 0.6, colour: b.colour });
    bus.emit('camera:shake', { amp: 0.16, freq: 18, duration: 0.42 });
    bus.emit('impact', {
      point: { x: s.x, y: s.y + 1.5, z: s.z },
      normal: { x: 0, y: 1, z: 0 }, kind: 'arcane_burst', magnitude: 0.8,
      colour: b.colour,
    });
    bus.emit('vfx:spawn', {
      kind: 'shrine.burst', position: { x: s.x, y: s.y + 1.55, z: s.z },
      colour: b.colour, radius: 2.6, duration: 1.3, up: 1,
    });
    bus.emit('director:shrine', {
      id: s.id, blessing: b.id, label: b.label, colour: b.colour,
      duration: b.duration, x: s.x, z: s.z, used: this.world.shrinesUsed,
    });
    director?.objectives?.noteShrine?.();
    return s;
  }

  /* ================================================================ *
   * rings (wave telegraph + boss phase)
   * ================================================================ */

  armWaveRing(centre, radius) {
    this._waveRing = { x: centre.x, z: centre.z, r: Math.max(4, radius), charge: 0, tier: 0, colour: 0x8fe07a };
  }
  setWaveCharge(charge, tier) {
    if (!this._waveRing) return;
    this._waveRing.charge = clamp01(charge);
    this._waveRing.tier = clamp01(tier);
  }
  disarmWaveRing() { this._waveRing = null; }

  /**
   * The phase-II summoning circle under the boss.
   *
   * Sized to the *boss*, not to the arena. An arena-wide ring is a 30 m additive
   * disc that swallows the whole frame and reads as a lens flare, not as a
   * ritual; a ~12 m circle around a 6.5 m body reads as the thing it stands in.
   */
  armBossRing(boss, world) {
    const x = boss?.position?.x ?? 0;
    const z = boss?.position?.z ?? 0;
    const d = this.engine.get('dungeon');
    const bodyR = Math.max(2.0, boss?.radius ?? 2.35);
    const r = Math.min(bodyR * 2.6, d?.arena?.r ? d.arena.r * 0.46 : 7.0);
    this._bossRing = {
      x: d?.arena?.x ?? x, z: d?.arena?.z ?? z, r,
      charge: 1, colour: 0xff5a1e, entity: boss ?? null,
    };
    void world;
  }
  disarmBossRing() { this._bossRing = null; }

  /* ================================================================ *
   * per-frame write
   * ================================================================ */

  /** Static parts (plinth, floor position) — rewritten only when sites change. */
  _writeStatic() {
    if (!this.ready) return;
    const n = Math.min(this.sites.length, MAX_SHRINES);
    for (let i = 0; i < n; i++) {
      const s = this.sites[i];
      this._q.setFromAxisAngle(_UP, s.yaw);
      this._m.compose(this._v.set(s.x, s.y, s.z), this._q, this._s.set(1, 1, 1));
      this.plinthMesh.setMatrixAt(i, this._m);
    }
    for (let i = n; i < MAX_SHRINES; i++) this.plinthMesh.setMatrixAt(i, this._hidden);
    this.plinthMesh.count = n;
    this.plinthMesh.instanceMatrix.needsUpdate = true;
  }

  /** Animated parts: rune bob, sigil breathe, shaft, light gain. */
  sync(elapsed) {
    if (!this.ready) return;
    const n = Math.min(this.sites.length, MAX_SHRINES);

    let sig = 0;
    let keyIdx = -1, keyScore = -1, keyY = 0, keyGlow = 0;
    const cam = this.engine.camera;

    for (let i = 0; i < n; i++) {
      const s = this.sites[i];
      const live = s.state === 'ready';
      const glow = live ? 0.34 + s.charge * 0.66 : clamp01(s.charge) * 0.25;

      /* --- rune stone: bob + slow spin, brighter as it charges --- */
      const bob = Math.sin(elapsed * 1.15 + s.pulse) * 0.055 + Math.sin(elapsed * 2.7 + s.pulse * 1.7) * 0.018;
      const spin = elapsed * (live ? 0.62 : 0.10) + s.pulse;
      this._q.setFromAxisAngle(_UP, spin);
      const rs = 0.88 + glow * 0.22;
      this._m.compose(this._v.set(s.x, s.y + 1.72 + bob, s.z), this._q, this._s.set(rs, rs, rs));
      this.runeMesh.setMatrixAt(i, this._m);
      this._col.set(s.blessing.colour);
      const flick = 0.88 + 0.12 * Math.sin(elapsed * 5.3 + s.pulse * 2.1);
      // Ceiling below 1: the baked tip gradient (up to 1.51x) is what crosses the
      // bloom threshold, so the body of the crystal keeps its hue.
      this._col.multiplyScalar((0.22 + glow * 0.60) * flick);
      this.runeMesh.setColorAt(i, this._col);

      /* --- floor sigil --- */
      const breathe = 0.90 + 0.10 * Math.sin(elapsed * 1.9 + s.pulse);
      const rr = 2.75 * (0.94 + glow * 0.10);
      this._q.setFromAxisAngle(_UP, s.yaw + elapsed * (live ? 0.055 : 0.008));
      this._m.compose(this._v.set(s.x, s.y + 0.022, s.z), this._q, this._s.set(rr, 1, rr));
      this.sigilMesh.setMatrixAt(sig, this._m);
      this._col.set(s.blessing.colour);
      /* 0.86 was a scene-referred number and the grade pass is not: it lifts
         midtones by ~3x (crypt look: blackPoint 0.028, whitePoint 0.72, contrast
         1.38 about pivot 0.44), so an additive 0.86 in the dominant channel
         resolved at 253/255 — the sigil was the brightest thing in the frame and
         the flagstones under it were gone. Held to ~0.11 the same ward lands near
         150/255, keeps its hue instead of railing to cream, and the stone reads
         straight through it. */
      this._col.multiplyScalar(clamp01(glow * breathe) * 0.155);
      this.sigilMesh.setColorAt(sig, this._col);
      sig++;

      /* --- shaft: only meaningful on a live shrine --- */
      const shaftGain = live ? Math.pow(clamp01(s.charge), 1.4) : 0;
      const sw = 0.55 + shaftGain * 0.55;
      this._q.setFromAxisAngle(_UP, elapsed * 0.22 + s.pulse);
      this._m.compose(this._v.set(s.x, s.y + 0.05, s.z), this._q, this._s.set(sw, 0.55 + shaftGain * 0.6, sw));
      this.shaftMesh.setMatrixAt(i, this._m);
      this._col.set(s.blessing.colour);
      this._col.multiplyScalar(shaftGain * 0.80);
      this.shaftMesh.setColorAt(i, this._col);

      /* --- who gets the one real light: nearest to camera, brightest first --- */
      const dx = s.x - cam.position.x, dz = s.z - cam.position.z;
      const score = (0.45 + glow) / (1 + Math.hypot(dx, dz) * 0.06);
      if (score > keyScore) { keyScore = score; keyIdx = i; keyY = s.y + 1.72 + bob; keyGlow = glow; }
    }
    for (let i = n; i < MAX_SHRINES; i++) {
      this.runeMesh.setMatrixAt(i, this._hidden);
      this.shaftMesh.setMatrixAt(i, this._hidden);
    }
    this.runeMesh.count = n;
    this.shaftMesh.count = n;

    /* --- the key light: our one real source, at the winning shrine --- */
    if (this.light) {
      if (keyIdx < 0) {
        this.light.intensity = 0;
        this._lightOwner = -1;
      } else {
        const s = this.sites[keyIdx];
        this._lightOwner = keyIdx;
        /* The source sits *low*, inside the sigil ring, not up at the crystal.
           A point light level with the rune is directly above every face of the
           plinth, so the capital blows to white and the vertical faces — the
           whole silhouette — stay black. Uplighting from the burning sigil is
           both the more motivated read and the one that actually shows the
           stone: the shaft and capital catch it side-on and the plinth reads. */
        this.light.position.set(s.x, s.y + 0.72, s.z);
        /* Pulled 30 % toward white. A fully saturated key light turns the stone
           into coloured plastic and eats every bit of its albedo and grain; a
           desaturated one reads as *stone lit by a violet rune*. */
        this.light.color.set(s.blessing.colour).lerp(_WHITE, 0.30);
        // A slow magical breathe, not a fire flicker — deterministic on elapsed.
        const br = 0.86 + 0.14 * Math.sin(elapsed * 1.7 + s.pulse) + 0.05 * Math.sin(elapsed * 4.1 + s.pulse * 2.3);
        this.light.intensity = (1.7 + keyGlow * 4.6) * br;
        this.light.distance = 9.5 + keyGlow * 3.5;
      }
    }

    /* --- the wave ring --- */
    if (this._waveRing && sig < MAX_SIGILS) {
      const w = this._waveRing;
      const pulseHz = 2.2 + w.tier * 3.4;
      const pulse = 0.55 + 0.45 * Math.sin(elapsed * pulseHz);
      const r = w.r * 2 * (0.97 + 0.03 * pulse);
      this._q.setFromAxisAngle(_UP, elapsed * 0.13);
      this._m.compose(this._v.set(w.x, this._floorAt(w.x, w.z) + 0.020, w.z), this._q, this._s.set(r, 1, r));
      this.sigilMesh.setMatrixAt(sig, this._m);
      this._col.set(w.colour).lerp(_RED, w.tier * 0.75);
      // Same ceiling as the shrine sigils — see the note there. A horde ring is
      // 8-14 m across, so it is the LAST thing that may be allowed to clip.
      this._col.multiplyScalar(clamp01(w.charge) * (0.045 + pulse * 0.095));
      this.sigilMesh.setColorAt(sig, this._col);
      sig++;
    }

    /* --- the boss phase ring --- */
    if (this._bossRing && sig < MAX_SIGILS) {
      const b = this._bossRing;
      const pulse = 0.62 + 0.38 * Math.sin(elapsed * 1.35);
      const r = b.r * 2 * (0.985 + 0.015 * Math.sin(elapsed * 0.9));
      this._q.setFromAxisAngle(_UP, -elapsed * 0.075);
      this._m.compose(this._v.set(b.x, this._floorAt(b.x, b.z) + 0.018, b.z), this._q, this._s.set(r, 1, r));
      this.sigilMesh.setMatrixAt(sig, this._m);
      // Same ceiling as the shrine sigils — see the note there.
      this._col.set(b.colour).multiplyScalar(clamp01(b.charge) * (0.030 + pulse * 0.075));
      this.sigilMesh.setColorAt(sig, this._col);
      sig++;
    }

    for (let i = sig; i < MAX_SIGILS; i++) this.sigilMesh.setMatrixAt(i, this._hidden);
    this.sigilMesh.count = sig;

    this.runeMesh.instanceMatrix.needsUpdate = true;
    this.shaftMesh.instanceMatrix.needsUpdate = true;
    this.sigilMesh.instanceMatrix.needsUpdate = true;
    if (this.runeMesh.instanceColor) this.runeMesh.instanceColor.needsUpdate = true;
    if (this.shaftMesh.instanceColor) this.shaftMesh.instanceColor.needsUpdate = true;
    if (this.sigilMesh.instanceColor) this.sigilMesh.instanceColor.needsUpdate = true;
  }

  /* ================================================================ *
   * helpers
   * ================================================================ */

  _standable(x, z, clearance = 0.7) {
    const d = this.engine.get('dungeon');
    if (!d || d.__dead || !d.active) return true;
    try {
      if (typeof d.isWalkable === 'function' && !d.isWalkable(x, z)) return false;
      if (typeof d.clearanceAt === 'function' && d.clearanceAt(x, z) < clearance) return false;
    } catch { return true; }
    return true;
  }

  _floorAt(x, z) {
    const d = this.engine.get('dungeon');
    if (d && !d.__dead && d.active && typeof d.floorHeightAt === 'function') {
      try { const h = d.floorHeightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      try { const h = t.heightAt(x, z); if (Number.isFinite(h)) return h; } catch { /* noop */ }
    }
    return 0;
  }

  /**
   * Release any pooled practicals a previous build claimed. Shrines light
   * themselves with their own point light now, so this only ever has work to do
   * if a future revision goes back to the pool — keeping it means a rebuild can
   * never leak a light either way.
   */
  _releaseTorches() {
    if (!this._torches.length) return;
    const lighting = this.engine.get('lighting');
    for (const t of this._torches) { try { lighting?.removeTorch?.(t); } catch { /* noop */ } }
    this._torches.length = 0;
  }

  report() {
    return {
      count: this.sites.length,
      drawCalls: this.drawCalls,
      used: this.world.shrinesUsed,
      sites: this.sites.map((s) => ({
        id: s.id, blessing: s.blessing.id, state: s.state,
        x: +s.x.toFixed(2), z: +s.z.toFixed(2), charge: +s.charge.toFixed(2),
      })),
      waveRing: !!this._waveRing,
      bossRing: !!this._bossRing,
    };
  }

  dispose() {
    this._releaseTorches();
    this.group.removeFromParent();
    for (const g of this._geos) { try { g.dispose(); } catch { /* noop */ } }
    this._geos.length = 0;
    for (const m of this._mats) { try { m.dispose(); } catch { /* noop */ } }
    this._mats.length = 0;
    for (const t of this._texs ?? []) { try { t.dispose(); } catch { /* noop */ } }
    if (this._texs) this._texs.length = 0;
    this.sites.length = 0;
    this.ready = false;
  }
}

const _UP = new THREE.Vector3(0, 1, 0);
const _RED = new THREE.Color(0xff3a12);
const _WHITE = new THREE.Color(0xffffff);

/**
 * Bake a vertical value ramp into a gem's vertex colours: hot at the two tips,
 * deep at the waist. Multiplied by the per-instance colour at draw time, so one
 * shared geometry serves every blessing hue and only the tips bloom.
 */
function bakeGemGradient(geo) {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  let maxY = 1e-6;
  for (let i = 0; i < n; i++) maxY = Math.max(maxY, Math.abs(pos.getY(i)));
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = Math.abs(pos.getY(i)) / maxY;            // 0 at the waist, 1 at a tip
    const v = 0.46 + Math.pow(t, 1.35) * 1.05;         // 0.46 .. 1.51
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

export default Shrines;
