/**
 * THE NINTH VIGIL — Hit feel
 * ---------------------------------------------------------------------------
 * The difference between a tech demo and a game is almost entirely in this file.
 * Nothing here decides *whether* a blow lands — CombatSystem does that. This is
 * everything that happens in the 200 ms afterwards:
 *
 *   HitFeel   hit-stop, knockback, stagger, screen shake, floating numbers
 *   GroundFX  ground reads — telegraphs, AoE sweeps, impact pulses, soft-lock
 *   AbilityFX the abilities' own light — projectiles, the beam, the spin arc
 *
 * Why hit-stop matters most
 * -------------------------
 * A landed hit freezes the attacker's swing and the victim's animation for
 * 60–110 ms scaled by damage. The frames stop, the eye catches up, and the blow
 * reads as a collision instead of a pass-through. No particle system buys as
 * much impact as that one pause, which is why it is implemented on the animation
 * clocks of both parties rather than as a global time-scale (a global pause
 * stops the camera and the world too, and reads as a stutter).
 *
 * Rendering budget
 * ----------------
 * Five draw calls, total, for everything above: one instanced quad batch for
 * ground reads, one for glyphs, one for projectiles, one beam, one spin arc.
 * No lit materials, so **zero** additional fragment texture units against the
 * 16-unit budget except the single glyph atlas (which is unlit and only ever
 * bound by its own shader).
 *
 * Determinism: every wobble is a pure function of `engine.clock.elapsed` and a
 * per-item integer seed. No Math.random, no wall clock.
 */

import * as THREE from 'three';
import { TIER_COLOR, TYPE_COLOR } from './Damage.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Deterministic 0..1 from an integer — replaces every Math.random here. */
const h1 = (n) => {
  let x = (n | 0) * 374761393 + 668265263;
  x = (x ^ (x >>> 13)) * 1274126177;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

const _v = new THREE.Vector3();
const _c = new THREE.Color();

/* ================================================================== *
 * instanced-quad plumbing shared by all three renderers
 * ================================================================== */

/**
 * A ground-plane or billboard quad batch. Uses InstancedBufferGeometry rather
 * than InstancedMesh so the vertex shader owns the transform outright — the
 * batch never depends on three injecting `instanceMatrix`, and per-instance
 * yaw/size is one attribute fetch instead of a matrix multiply.
 */
function quadBatch(count, attrs, opts = {}) {
  const src = new THREE.PlaneGeometry(1, 1, 1, 1);
  if (opts.ground) src.rotateX(-Math.PI * 0.5);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute('position', src.getAttribute('position'));
  geo.setAttribute('uv', src.getAttribute('uv'));
  const store = {};
  for (const [name, size] of attrs) {
    const arr = new Float32Array(count * size);
    const a = new THREE.InstancedBufferAttribute(arr, size);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    store[name] = a;
  }
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  src.dispose();
  return { geo, attrs: store, count };
}

/* ================================================================== *
 * glyph atlas — procedural, no external font file, one 512² texture
 * ================================================================== */

const GLYPHS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '!', '+', '−', '×', '%', ' '];
const GLYPH_INDEX = (() => {
  const m = new Map();
  GLYPHS.forEach((g, i) => m.set(g, i));
  m.set('-', 12);
  m.set('x', 13);
  return m;
})();
const ATLAS_COLS = 4;
const ATLAS_CELL = 128;

/**
 * Build the numeral atlas. Channel layout, which the shader relies on:
 *   R  glyph body mask
 *   G  outline mask (dilated silhouette minus the body) — this is what makes a
 *      number readable over a torchlit stone floor at 30 m
 *   B  vertical bevel term, so the numeral is lit from above like struck metal
 */
function buildGlyphAtlas(engine) {
  const S = ATLAS_COLS * ATLAS_CELL;
  const mk = () => {
    const cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    return cv;
  };
  const font = `bold ${Math.round(ATLAS_CELL * 0.80)}px "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif`;
  const cvA = mk(), cvB = mk();
  const a = cvA.getContext('2d', { willReadFrequently: true });
  const b = cvB.getContext('2d', { willReadFrequently: true });
  const widths = new Float32Array(GLYPHS.length);

  for (const ctx of [a, b]) {
    ctx.clearRect(0, 0, S, S);
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 2;
  }
  b.lineWidth = ATLAS_CELL * 0.135;

  for (let i = 0; i < GLYPHS.length; i++) {
    const g = GLYPHS[i];
    const cx = (i % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL * 0.5;
    const cy = Math.floor(i / ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL * 0.52;
    let w = ATLAS_CELL * 0.5;
    try { w = a.measureText(g).width; } catch { /* keep the default */ }
    widths[i] = clamp(w / ATLAS_CELL, 0.16, 1);
    if (g === ' ') continue;
    a.fillText(g, cx, cy);
    b.strokeText(g, cx, cy);
    b.fillText(g, cx, cy);
  }

  const pa = a.getImageData(0, 0, S, S).data;
  const pb = b.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    // bevel ramp runs across each cell, top bright -> bottom dim
    const cellY = (y % ATLAS_CELL) / ATLAS_CELL;
    const bev = Math.round(clamp01(1.05 - cellY * 1.15) * 255);
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const body = pa[i + 3];
      const dil = pb[i + 3];
      out[i] = body;
      out[i + 1] = dil > body ? dil - body : 0;
      out[i + 2] = bev;
      out[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(out, S, S, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = Math.min(4, engine?.maxAniso ?? 1);
  tex.needsUpdate = true;
  return { tex, widths };
}

/* ================================================================== *
 * HitFeel — impact response + floating numbers
 * ================================================================== */

const MAX_NUMBERS = 56;
const MAX_GLYPHS = MAX_NUMBERS * 7;

export class HitFeel {
  /**
   * @param {import('../core/Engine.js').Engine} engine
   * @param {object} combat owning CombatSystem (read-only use)
   */
  constructor(engine, combat) {
    this.engine = engine;
    this.combat = combat;

    /** @type {Array<object>} live floating numbers */
    this.numbers = [];
    this._seq = 0;
    /** per-target stack counter so five hits do not print on top of each other */
    this._stack = new Map();

    /** @type {Array<{obj:object, until:number, prev:number, kind:string}>} */
    this._stops = [];
    this._shakeBudget = 0;
    this._lastShake = -1;

    this.group = new THREE.Group();
    this.group.name = 'combat:numbers';
    this.group.matrixAutoUpdate = false;
    this.batch = null;
    this.mat = null;
    this.atlas = null;
    this.enabled = true;
    /** Set false once a HUD module exists and claims the number channel. */
    this.drawNumbers = true;
    this._hudChecked = -1;
  }

  init() {
    const { tex, widths } = buildGlyphAtlas(this.engine);
    this.atlas = tex;
    this.glyphW = widths;

    this.batch = quadBatch(MAX_GLYPHS, [
      ['aPos', 3],      // world position of the glyph centre
      ['aCell', 2],     // atlas cell origin, 0..1
      ['aTint', 3],
      ['aMeta', 4],     // size, alpha, outlineDark, bevelGain
    ]);

    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      uniforms: {
        uAtlas: { value: tex },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uCell: { value: 1 / ATLAS_COLS },
      },
      vertexShader: /* glsl */`
        attribute vec3 aPos; attribute vec2 aCell; attribute vec3 aTint; attribute vec4 aMeta;
        uniform vec3 uRight; uniform vec3 uUp; uniform float uCell;
        varying vec2 vUv; varying vec3 vTint; varying vec3 vMeta;
        void main() {
          vUv = aCell + uv * uCell;
          vTint = aTint;
          vMeta = aMeta.yzw;
          vec3 wp = aPos + uRight * position.x * aMeta.x + uUp * position.y * aMeta.x;
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uAtlas;
        varying vec2 vUv; varying vec3 vTint; varying vec3 vMeta;
        void main() {
          vec3 s = texture2D( uAtlas, vUv ).rgb;
          float body = s.r;
          float line = s.g;
          float a = clamp( body + line * 0.98, 0.0, 1.0 ) * vMeta.x;
          if ( a < 0.008 ) discard;
          // struck-metal read: bright top, warm core, near-black rim
          vec3 lit = vTint * ( 0.62 + s.b * vMeta.z );
          vec3 rim = vTint * 0.045 + vec3( 0.008, 0.006, 0.006 );
          vec3 c = mix( rim, lit, smoothstep( 0.35, 0.72, body ) );
          gl_FragColor = vec4( c, a );
        }`,
    });

    const mesh = new THREE.Mesh(this.batch.geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 40;
    mesh.userData.noGBuffer = true;
    mesh.userData.occluder = false;
    mesh.userData.noOcclude = true;
    this.mesh = mesh;
    this.group.add(mesh);
    this.engine.scene.add(this.group);
  }

  /* ------------------------------------------------------------ feel */

  /**
   * One landed hit, fully dressed: hit-stop on both parties, mass-scaled
   * knockback, stagger, camera shake scaled by weight, and the number.
   * @param {object} p a `damage` payload from DamageResolver
   */
  land(p) {
    if (!p) return;
    try {
      if (!p.dot) {
        this.hitstop(p.source, num(p.hitstop, 0.05) * (p.lethal ? 1.35 : 1));
        this.hitstop(p.target, num(p.hitstop, 0.05) * (p.lethal ? 1.6 : 1.15));
        this.knockback(p);
        this.shake(p);
      }
      this.number(p);
      if (!p.dot && (p.crit || num(p.impact, 0) > 1.1 || p.lethal)) this.impactPulse(p);
    } catch (e) {
      console.warn('[hitfeel] land failed —', e?.message ?? e);
    }
  }

  /**
   * Freeze an actor's animation clock briefly. Implemented on the clip clock of
   * the actor itself: the hero's additive action layer, an enemy's AnimGraph
   * speed. Restored by `update` even if the actor is hit again meanwhile.
   */
  hitstop(actor, seconds) {
    const s = clamp(num(seconds, 0), 0, 0.16);
    if (!actor || s <= 0.004) return;
    const until = this.engine.clock.elapsed + s;

    /* hero: slow the action (swing) layer, not the base locomotion clock —
       stopping the base layer would freeze the feet mid-stride. */
    if (actor.isHero) {
      const act = actor.graph?.act;
      if (!act) return;
      const rec = this._stops.find((r) => r.obj === act);
      if (rec) { rec.until = Math.max(rec.until, until); return; }
      this._stops.push({ obj: act, until, prev: num(act.speed, 1), kind: 'anim' });
      act.speed = 0.045;
      return;
    }

    const anim = actor.anim;
    if (!anim || typeof anim.speed !== 'number') return;
    const rec = this._stops.find((r) => r.obj === anim);
    if (rec) { rec.until = Math.max(rec.until, until); return; }
    this._stops.push({ obj: anim, until, prev: anim.speed, kind: 'anim' });
    anim.speed = 0.05;
  }

  /**
   * Mass-scaled impulse. Bestiary integrates `kbX/kbZ` into the body's position
   * and the AI reads that position back, so writing those two numbers is a real
   * push through both systems rather than a cosmetic slide.
   */
  knockback(p) {
    const t = p.target;
    if (!t || t.isHero) return;
    const k = num(p.knockback, 0);
    if (k <= 0.02) return;
    let dx = 0, dz = 1;
    const from = p.hitPoint;
    if (from && Number.isFinite(from.x)) {
      dx = num(t.position?.x, 0) - from.x;
      dz = num(t.position?.z, 0) - from.z;
    } else if (p.source?.position) {
      dx = num(t.position?.x, 0) - num(p.source.position.x, 0);
      dz = num(t.position?.z, 0) - num(p.source.position.z, 0);
    }
    const l = Math.hypot(dx, dz);
    if (l < 1e-4) { dx = 0; dz = 1; } else { dx /= l; dz /= l; }
    // Bestiary adds its own damage-scaled nudge; this is the ability's weight on
    // top of it, so keep the coefficient modest or bodies ski across the floor.
    const g = t.def?.isBoss ? 0.05 : t.elite ? 0.34 : 0.62;
    if (typeof t.kbX === 'number') { t.kbX += dx * k * g; t.kbZ += dz * k * g; }

    /* stagger: hand the interrupt to whoever owns the animation state */
    const st = num(p.stagger, 0);
    if (st > 0.22 && !t.def?.isBoss) {
      const ag = this.engine.get('ai');
      const agent = ag?.byEntity?.get?.(t);
      if (agent) agent.staggerFor = Math.max(num(agent.staggerFor, 0), clamp(st * 0.9, 0.18, 1.1));
    }
  }

  /** Camera shake, weight-scaled and rate-gated so a flurry never chatters. */
  shake(p) {
    const amp = num(p.shake, 0);
    if (amp < 0.012) return;
    const e = this.engine.clock.elapsed;
    if (e - this._lastShake < 0.045) return;
    this._lastShake = e;
    // Distance falloff: an offscreen cleave must not kick the frame.
    const cam = this.engine.camera;
    let near = 1;
    const hp = p.hitPoint;
    if (cam && hp && Number.isFinite(hp.x)) {
      near = clamp01(1 - Math.hypot(hp.x - cam.position.x, hp.z - cam.position.z) / 52);
      near = 0.35 + near * near * 0.65;
    }
    const a = clamp(amp * near * (p.crit ? 1.35 : 1), 0.012, 0.85);
    this.engine.bus.emit('camera:shake', {
      amp: a, freq: clamp(26 - a * 22, 8, 28), duration: clamp(0.16 + a * 0.7, 0.14, 0.8),
    });
  }

  /* --------------------------------------------------------- numbers */

  /** Spawn a floating number from a damage payload. */
  number(p) {
    if (!p || !(num(p.amount, 0) > 0) && !p.text) return;
    const bus = this.engine.bus;
    const tier = p.tier ?? (p.crit ? 'crit' : 'normal');
    const toHero = !!p.target?.isHero;
    const key = toHero ? 'player' : tier;
    const hex = TIER_COLOR[key] ?? TIER_COLOR.normal;

    /* Type tint: a fire hit is orange-gold, a shadow hit violet — the rarity
       ramp still owns the *tier*, the element only shifts the hue. */
    _c.setHex(hex);
    if (p.type && p.type !== 'physical' && TYPE_COLOR[p.type]) {
      _c.lerp(_v2col(p.type), tier === 'crit' || tier === 'brutal' ? 0.35 : 0.62);
    }

    // hand it to the HUD, which may render its own; we draw only if none does
    bus.emit('damage:number', {
      amount: p.amount, tier, type: p.type, crit: !!p.crit, color: _c.getHex(),
      at: p.hitPoint ?? p.target?.position ?? null, target: p.target, dot: !!p.dot,
    });
    if (!this.drawNumbers || !this.batch) return;

    const t = p.target;
    const pos = _v.set(0, 0, 0);
    const hp = p.hitPoint;
    const height = num(t?.height, num(t?.stats?.height, 1.8));
    if (hp && Number.isFinite(hp.x)) pos.set(hp.x, hp.y, hp.z);
    else if (t?.position && Number.isFinite(t.position.x)) {
      pos.set(t.position.x, t.position.y + height * 0.72, t.position.z);
    } else return;

    /* stack: successive hits on one body climb, so a whirlwind reads as a column
       of numbers instead of one flickering glyph */
    const now = this.engine.clock.elapsed;
    let st = this._stack.get(t);
    if (!st || now - st.t > 0.85) st = { n: 0, t: now };
    st.n = (st.n + 1) % 6; st.t = now;
    this._stack.set(t, st);

    const seed = ++this._seq;
    const r1 = h1(seed * 7 + 11), r2 = h1(seed * 13 + 5);
    const glyphs = [];
    const digits = String(Math.max(1, Math.round(num(p.amount, 1))));
    for (let i = 0; i < digits.length && i < 6; i++) {
      glyphs.push(GLYPH_INDEX.get(digits[i]) ?? 0);
    }
    if (p.crit && glyphs.length < 6) glyphs.push(10);   // '!'

    if (this.numbers.length >= MAX_NUMBERS) this.numbers.shift();
    const big = tier === 'crit' || tier === 'brutal' || tier === 'execute';
    this.numbers.push({
      x: pos.x + (r1 - 0.5) * 0.5,
      y: pos.y + 0.18 + st.n * 0.20,
      z: pos.z + (r2 - 0.5) * 0.5,
      vx: (r1 - 0.5) * 0.55,
      vz: (r2 - 0.5) * 0.55,
      vy: big ? 2.05 : 1.62,
      age: 0,
      life: p.dot ? 0.72 : big ? 1.35 : 1.05,
      /* Size is authored as a fraction of *screen height*, not in metres. An
         ARPG camera sits 26–34 m out; a number sized in world units would read
         as 12 px there and vanish. Resolved against the live camera each frame.
         The value is the glyph *cell*; a numeral's cap height is ~0.58 of it,
         so 0.052 lands a normal hit at ~27 px on a 900 px frame. */
      frac: (p.dot ? 0.034 : big ? 0.078 : 0.052) * (toHero ? 1.15 : 1),
      pop: big ? 1.9 : 1.4,
      tint: _c.clone(),
      glyphs,
      seed,
      bevel: big ? 1.05 : 0.66,
    });
  }

  /** A ground pulse where the blow landed — sold as an impact, not a decal. */
  impactPulse(p) {
    const g = this.combat?.groundFX;
    if (!g) return;
    const t = p.target;
    const x = num(p.hitPoint?.x, num(t?.position?.x, NaN));
    const z = num(p.hitPoint?.z, num(t?.position?.z, NaN));
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const heavy = p.lethal ? 1.5 : p.crit ? 1.1 : 0.85;
    g.pulse(x, z, num(p.impact, 1) * 1.25 * heavy, p.lethal ? 0xffd0a0 : (TYPE_COLOR[p.type] ?? 0xffe0bb));
  }

  /* ----------------------------------------------------------- frame */

  update(dt, elapsed) {
    /* release expired hit-stops */
    for (let i = this._stops.length - 1; i >= 0; i--) {
      const r = this._stops[i];
      if (elapsed < r.until) continue;
      try { r.obj.speed = r.prev; } catch { /* actor went away */ }
      this._stops.splice(i, 1);
    }

    /* the HUD may appear after us; hand the channel over if it does */
    if (elapsed - this._hudChecked > 0.5) {
      this._hudChecked = elapsed;
      const hud = this.engine.get('hud');
      const owns = hud && !hud.__dead && (
        hud.drawsDamageNumbers === true
        || typeof hud.damageNumber === 'function'
        || typeof hud.combat?.onDamage === 'function'
      );
      if (owns) {
        this.drawNumbers = false;
        if (this.numbers.length) this.numbers.length = 0;
      }
    }

    if (!this.batch) return;

    /* ---- integrate + write the glyph batch ---- */
    const A = this.batch.attrs;
    const pos = A.aPos.array, cell = A.aCell.array, tint = A.aTint.array, meta = A.aMeta.array;
    const inv = 1 / ATLAS_COLS;
    let gi = 0;

    /* metres per unit of screen height at a given distance, for this camera */
    const cam0 = this.engine.camera;
    const tanHalf = cam0 ? Math.tan((cam0.fov ?? 46) * Math.PI / 360) : 0.42;

    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.age += dt;
      if (n.age >= n.life) { this.numbers.splice(i, 1); continue; }
      const u = n.age / n.life;
      // rise fast, then float: a decelerating arc reads as thrown, not launched
      const rise = n.vy * n.age * (1 - u * 0.62);
      const sway = Math.sin((n.age * 5.2) + n.seed * 0.7) * 0.055 * (1 - u);
      const px = n.x + n.vx * n.age * (1 - u * 0.5) + sway;
      const py = n.y + rise;
      const pz = n.z + n.vz * n.age * (1 - u * 0.5);
      // overshoot pop on spawn, fade over the last third
      const popT = clamp01(n.age / 0.11);
      let dist = 26;
      if (cam0) dist = Math.hypot(px - cam0.position.x, py - cam0.position.y, pz - cam0.position.z);
      const world = clamp(2 * dist * tanHalf, 4, 90) * n.frac;
      const scale = world * (1 + (n.pop - 1) * Math.sin(popT * Math.PI * 0.85) * (1 - popT * 0.55));
      const alpha = clamp01(popT * 1.6) * (1 - clamp01((u - 0.62) / 0.38) ** 1.5);

      /* layout: advance by measured glyph width so numerals kern instead of
         sitting on a fixed grid (a '1' next to a '0' is the giveaway) */
      let total = 0;
      for (const g of n.glyphs) total += (this.glyphW[g] ?? 0.5) + 0.05;
      let cursor = -total * 0.5;
      for (let k = 0; k < n.glyphs.length; k++) {
        if (gi >= MAX_GLYPHS) break;
        const g = n.glyphs[k];
        const w = (this.glyphW[g] ?? 0.5) + 0.05;
        const ox = (cursor + w * 0.5) * scale;
        cursor += w;
        const o3 = gi * 3, o2 = gi * 2, o4 = gi * 4;
        pos[o3] = px + ox; pos[o3 + 1] = py; pos[o3 + 2] = pz;
        cell[o2] = (g % ATLAS_COLS) * inv;
        cell[o2 + 1] = 1 - (Math.floor(g / ATLAS_COLS) + 1) * inv;
        tint[o3] = n.tint.r; tint[o3 + 1] = n.tint.g; tint[o3 + 2] = n.tint.b;
        meta[o4] = scale; meta[o4 + 1] = alpha; meta[o4 + 2] = n.bevel; meta[o4 + 3] = 0;
        gi++;
      }
    }

    this.batch.geo.instanceCount = gi;
    if (gi > 0) {
      A.aPos.needsUpdate = true; A.aCell.needsUpdate = true;
      A.aTint.needsUpdate = true; A.aMeta.needsUpdate = true;
    }
    this.mesh.visible = gi > 0;

    /* billboard basis */
    const cam = this.engine.camera;
    if (cam) {
      const m = cam.matrixWorld.elements;
      this.mat.uniforms.uRight.value.set(m[0], m[1], m[2]);
      this.mat.uniforms.uUp.value.set(m[4], m[5], m[6]);
    }
    void elapsed;
  }

  reset() {
    this.numbers.length = 0;
    this._stack.clear();
    for (const r of this._stops) { try { r.obj.speed = r.prev; } catch { /* gone */ } }
    this._stops.length = 0;
    if (this.batch) this.batch.geo.instanceCount = 0;
  }

  dispose() {
    this.reset();
    try {
      this.engine.scene.remove(this.group);
      this.batch?.geo.dispose();
      this.mat?.dispose();
      this.atlas?.dispose();
    } catch { /* noop */ }
  }
}

function _v2col(type) {
  return _COL2.setHex(TYPE_COLOR[type] ?? 0xffffff);
}
const _COL2 = new THREE.Color();

/* ================================================================== *
 * GroundFX — telegraphs, AoE sweeps, impact pulses, soft-lock reticle
 * ================================================================== */

const SHAPE = { CIRCLE: 0, RING: 1, CONE: 2, LINE: 3, RETICLE: 4, PULSE: 5 };
const MAX_IND = 48;

export class GroundFX {
  constructor(engine) {
    this.engine = engine;
    this.items = [];
    this._seq = 0;
    this.group = new THREE.Group();
    this.group.name = 'combat:ground';
    this.group.matrixAutoUpdate = false;
    this.batch = null;
    this._terrain = null;
  }

  init() {
    this.batch = quadBatch(MAX_IND, [
      ['aCentre', 3],
      ['aSize', 2],
      ['aYaw', 1],
      ['aColor', 3],
      ['aParams', 4],   // shape, progress, p0, p1
      ['aFade', 1],
    ], { ground: true });

    /* --- Why premultiplied alpha, and why every gain below is small ---------
     *
     * These quads are drawn into the pipeline's LINEAR HDR buffer, upstream of
     * auto-exposure and of bloom. A shader that writes ~1.0 linear therefore
     * resolves to ~1.0 x gain after exposure, and if that is over the bloom
     * threshold AND past the ACES shoulder it clips to white and grows a halo.
     * That is exactly how a ground read turns into a frame-destroying white blob.
     * So the hard ceiling here is CEIL = 0.70 against a REFERENCE gain of 1.85
     * (0.70 x 1.85 = 1.30 < 1.55): a telegraph is bright, but it can never bloom.
     *
     * THE GAIN IS NOT 1.85 ANY MORE, which is why `uExpNorm` exists. The grade
     * pass authors an exposure ceiling per scenario and they now run from 1.78x
     * (`overworld`) to 3.30x (`inventory`) — measured. At the boss arena's 2.73x
     * this ceiling landed at 1.91, over the bloom threshold, and the arena's
     * ground reads became the white plateau that ate the frame. So the pipeline
     * publishes `engine.vfxExposureNorm` (= 1.85 / live gain) and every gain
     * below is multiplied by it, which pins the ground read at the DISPLAY level
     * it was authored for regardless of how bright the scene had to be pushed.
     * A selection ring is a read, not a lit surface: display-referred is correct.
     *
     * Premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA) is what lets the fill be
     * a *tint* rather than a paint layer. dst * (1 - a) is a pure multiply, so
     * the floor's texture and its contrast ratio survive intact underneath; the
     * colour term only adds the warm/necrotic cast on top. A wide dark fill and
     * a thin hot rim can then coexist in one fragment without the alpha-division
     * hack the old composite needed.
     */
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
      side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uExpNorm: { value: 1 } },
      vertexShader: /* glsl */`
        attribute vec3 aCentre; attribute vec2 aSize; attribute float aYaw;
        attribute vec3 aColor;  attribute vec4 aParams; attribute float aFade;
        varying vec2 vL; varying vec3 vC; varying vec4 vP; varying float vF;
        void main() {
          vec2 l = vec2( position.x, position.z ) * 2.0;
          vL = l;
          vC = aColor; vP = aParams; vF = aFade;
          float c = cos( aYaw ), s = sin( aYaw );
          vec2 r = vec2( l.x * c - l.y * s, l.x * s + l.y * c ) * aSize * 0.5;
          vec3 wp = aCentre + vec3( r.x, 0.0, r.y );
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime;
        /* 1.85 / live exposure gain — see the material comment. 1.0 means the
           pipeline is running at the reference gain the ceilings assume. */
        uniform float uExpNorm;
        varying vec2 vL; varying vec3 vC; varying vec4 vP; varying float vF;

        /* Exposure-safe ceilings. See the comment on the material.
           RING_LUM / AREA_LUM replace the old per-channel CEIL: clamping channels
           railed red first, let green climb behind it and resolved every ground
           read as pale cream line art. A LUMINANCE target scales the colour as a
           whole, so the read stays under the hero's lit value AND keeps its hue. */
        /* MEASURED, not authored by eye. The grade pass is strongly expansive —
           the crypt look is blackPoint 0.028 / whitePoint 0.72 / contrast 1.38
           around pivot 0.44, a ~3x lift on midtones — so a value that looks safe
           in the HDR buffer resolves as clipped white on screen. 0.30 HDR luma
           through exposure(1.87) -> ACES -> sRGB -> grade lands at 253/255,
           which is exactly how a 5.4 m ring telegraph became the pure-white
           500 px circle that owned the dungeon frame. Solved for a target
           instead: 0.052 lands at ~140/255 in the crypt, ~180 on the night moor —
           a hot legible rim that sits below the lit flagstones beside it. */
        #define RING_LUM 0.115       /* SAFETY RAIL — see L_RIM for the authored level */
        #define AREA_LUM 0.050       /* safety rail for an area fill */
        #define L_RIM  0.078         /* authored peak LUMINANCE of the bright edge */
        #define WASH   0.13          /* interior tint gain — a cast, not a paint */
        #define SHADE  0.010         /* engraved shadow line gain (near black)   */
        #define FILL_A 0.30          /* interior coverage ceiling                */

        float band( float d, float r, float w ) { return smoothstep( w, 0.0, abs( d - r ) ); }

        /* Value noise — zero textures, a pure function of local position, so the
           frame stays byte-deterministic. This is what stops every ring in the
           game from being a geometrically perfect constant-value stroke. */
        float gHash( vec2 p ) {
          p = fract( p * vec2( 443.8975, 397.2973 ) );
          p += dot( p, p + 19.19 );
          return fract( ( p.x + p.y ) * p.x );
        }
        float gNoise( vec2 p ) {
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( gHash( i ), gHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                      mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
        }
        float gFbm( vec2 p ) {
          float a = 0.5, s = 0.0, n = 0.0;
          for ( int i = 0; i < 3; i++ ) { s += gNoise( p ) * a; n += a; p *= 2.03; a *= 0.5; }
          return s / n;
        }

        void main() {
          float shape = vP.x;
          float prog  = vP.y;
          float dd    = length( vL );
          float aa    = max( fwidth( dd ), 0.0022 ) * 1.5;
          float ang   = atan( vL.y, vL.x );

          /* Rim half-width in local (normalised-radius) units. Floored at a
             couple of pixels so it never vanishes, and capped so a 20 m ring is
             not outlined with a 2 m band. */
          float rw = clamp( aa * 2.1, 0.007, 0.045 );

          float fill = 0.0;     // wide, tints the floor, never hides it
          float edge = 0.0;     // thin, bright: this is what the player reads
          float dark = 0.0;     // thin, near-black, inset behind the bright edge

          if ( shape < 0.5 ) {
            /* filling disc — the classic ARPG danger read */
            float inside = smoothstep( aa, -aa, dd - 1.0 );
            float swept  = smoothstep( aa, -aa, dd - prog );
            // hatching gives the fill texture so it never reads as flat vinyl
            float hx = sin( ( vL.x + vL.y ) * 34.0 + uTime * 0.4 );
            float hatch = 0.74 + 0.26 * smoothstep( -0.25, 0.35, hx );
            fill = inside * ( 0.50 + swept * 0.50 ) * hatch;
            edge = band( dd, 1.0, rw )
                 + band( dd, prog, rw * 1.7 ) * 0.85 * step( 0.03, prog );
            dark = inside * band( dd, 1.0 - rw * 3.2, rw * 1.5 );
          } else if ( shape < 1.5 ) {
            /* annulus */
            float inner = vP.z;
            float inside = smoothstep( aa, -aa, dd - 1.0 ) * smoothstep( -aa, aa, dd - inner );
            float hatch = 0.70 + 0.30 * sin( ang * 26.0 + uTime * 1.6 );
            fill = inside * ( 0.55 + 0.45 * hatch );
            edge = band( dd, 1.0, rw ) + band( dd, inner, rw ) * 0.85;
            dark = inside * ( band( dd, 1.0 - rw * 3.2, rw * 1.5 )
                            + band( dd, inner + rw * 3.2, rw * 1.5 ) );
          } else if ( shape < 2.5 ) {
            /* cone: local +X is forward. The angular term is converted to arc
               length so the radial edges are the same thickness as the arc. */
            float halfArc = vP.z;
            float dang   = ( abs( ang ) - halfArc ) * max( dd, 0.06 );
            float within = smoothstep( aa, -aa, dang );
            float inside = within * smoothstep( aa, -aa, dd - 1.0 );
            float swept  = within * smoothstep( aa, -aa, dd - prog );
            float hatch = 0.72 + 0.28 * smoothstep( -0.2, 0.4, sin( dd * 30.0 - uTime * 3.0 ) );
            fill = inside * ( 0.48 + 0.52 * swept ) * hatch;
            edge = within * band( dd, 1.0, rw )
                 + within * band( dd, prog, rw * 1.8 ) * 0.9 * step( 0.03, prog )
                 + smoothstep( aa, -aa, dd - 1.0 ) * band( dang, 0.0, rw ) * 0.9;
            dark = inside * ( band( dd, 1.0 - rw * 3.2, rw * 1.5 )
                            + band( dang, -rw * 3.2, rw * 1.5 ) );
          } else if ( shape < 3.5 ) {
            /* rectangle / beam footprint, forward along +X from x = -1.
               across is normalised to the half-width, so it needs its own
               screen-space derivative — reusing the radial one would make the
               lane edges thick on a long thin quad. */
            float across = abs( vL.y );
            float along  = ( vL.x + 1.0 ) * 0.5;
            float ax = max( fwidth( across ), 0.004 ) * 1.5;
            float ay = max( fwidth( along ), 0.002 ) * 1.5;
            float rx = clamp( ax * 2.1, 0.02, 0.16 );
            float inside = smoothstep( ax, -ax, across - 1.0 )
                         * smoothstep( -ay, ay, along ) * smoothstep( ay, -ay, along - 1.0 );
            float swept  = smoothstep( ay, -ay, along - max( prog, 0.02 ) );
            fill = inside * ( 0.48 + 0.52 * swept );
            edge = inside * ( band( across, 1.0, rx ) )
                 + inside * band( across, 0.0, rx * 1.6 ) * 0.55
                 + smoothstep( ax, -ax, across - 1.0 ) * band( along, 1.0, ay * 2.4 ) * 0.8;
            dark = inside * band( across, 1.0 - rx * 2.6, rx * 1.3 );
          } else if ( shape < 4.5 ) {
            /* soft-lock reticle: dashed rotating ring + four chevrons. No fill —
               it is persistent, so it must never compete with the action. */
            float rot = ang + uTime * 0.9;
            float dash = step( 0.34, fract( rot * 2.5 ) );
            float ring = band( dd, 0.94, rw ) * dash;
            float ring2 = band( dd, 0.62, rw * 0.8 ) * 0.30;
            float ch = 0.0;
            for ( int i = 0; i < 4; i++ ) {
              float a0 = float( i ) * 1.5707963;
              float d2 = abs( atan( sin( ang - a0 ), cos( ang - a0 ) ) );
              ch += smoothstep( 0.30, 0.0, d2 ) * band( dd, 1.12 + 0.05 * sin( uTime * 3.4 ), rw * 1.4 );
            }
            edge = ( ring + ring2 + ch ) * 0.62;
          } else {
            /* impact pulse: a thin expanding shock ring */
            float r = mix( 0.12, 1.0, prog );
            float w = rw * 1.6 + 0.09 * ( 1.0 - prog );
            edge = band( dd, r, w ) * ( 1.0 - prog );
            fill = smoothstep( aa, -aa, dd - r ) * ( 1.0 - prog ) * 0.5;
          }

          /* --- erosion + flow -------------------------------------------------
             A ground read is light scouring across stone. Two coupled procedural
             fields make it one, both pure functions of local position (and uTime
             for the scroll), so the frame stays byte-deterministic:

               wear  pits the outline and eats its coverage, so no edge of it is
                     geometrically clean at any zoom,
               flow  scrolls charge along the shape, so the outline is never
                     uniformly lit around its own length.

             Without these, band() returns a constant value along a perfect
             analytic circle — which is the literal definition of 1-bit line art
             and is why every ring in the game read as a debug gizmo. */
          float ero  = gFbm( vL * 5.5 + vec2( 11.0, -7.0 ) );
          float fine = gNoise( vL * 19.0 );
          float flow = gFbm( vL * 3.1 + vec2( uTime * 0.20, -uTime * 0.13 ) );
          float wear = clamp( 0.26 + ero * 1.20 - fine * 0.22, 0.0, 1.0 );
          edge *= ( 0.30 + 0.70 * wear ) * ( 0.44 + 0.64 * flow );
          /* Radial ramp on the fill: it falls away toward the boundary instead of
             ending as a flat plate against a hard rim. */
          fill *= ( 0.34 + 0.66 * ( 1.0 - smoothstep( 0.45, 1.0, dd ) ) ) * ( 0.52 + 0.60 * ero );

          float m = clamp( vF, 0.0, 1.0 );
          // Deepen chroma rather than raise value: saturation is free against a
          // luminance-measured bloom threshold, brightness is not.
          float mx = max( vC.r, max( vC.g, vC.b ) );
          vec3 tint = pow( vC / max( mx, 1e-3 ), vec3( 1.30 ) ) * min( mx, 1.0 );
          // barely any white in the rim: desaturating toward white is what makes
          // an outline read as a blown highlight instead of hot metal
          vec3 hot  = mix( tint, vec3( 1.0 ), 0.04 );
          /* Unit-luminance form of the edge colour, so L_RIM is a display
             luminance rather than "some number times whatever hue was passed".
             A saturated orange carries ~0.59 the luminance of a pale cyan at the
             same channel level, so one gain made one of them three stops hotter.
             It also lets the final ceiling be a safety rail instead of a limiter:
             a limiter flattens everything above it onto a single value, which
             erased the erosion and flow modulation and put the clean
             constant-brightness stroke straight back. */
          float hotL = max( dot( hot, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
          vec3 hotN = hot / hotL;

          /* --- SHADOW layers and LIGHT layers are not the same operation ------
             The wash and the inset scribe are SHADOW: they multiply the floor
             down, so their coverage IS their occlusion. The bright edge is LIGHT:
             it has to add on top and leave the flagstone's grain and joints
             readable straight through it. Premultiplied blending resolves as
             dst * ( 1 - A ) + C, so keeping C while holding A low is exactly
             additive and raising A is exactly paint. The old composite ran the
             edge at 0.92 coverage, which erased the stone under it completely —
             that is what made a 5 m ring read as a painted white circle. */
          vec3 acc = vec3( 0.0 );
          float A = 0.0;
          float lightShare = 0.0;
          #define SHDW(LC,LA) { float la = clamp( LA, 0.0, 1.0 ); \
            acc = ( LC ) * la + acc * ( 1.0 - la ); A = la + A * ( 1.0 - la ); }
          #define LGHT(LC,LA,OCC) { float la = clamp( LA, 0.0, 1.0 ); float oa = la * ( OCC ); \
            acc += ( LC ) * la; A = oa + A * ( 1.0 - oa ); lightShare = max( lightShare, la ); }
          SHDW( tint * WASH,  fill * FILL_A * m )
          SHDW( tint * SHADE, dark * 0.52 * m )
          LGHT( hotN * L_RIM, edge * 0.92 * m, 0.26 )
          #undef SHDW
          #undef LGHT

          float a = clamp( A, 0.0, 1.0 );
          if ( a < 0.006 ) discard;
          /* Hold the LUMINANCE under the authored ceiling first, then normalise
             for the live exposure gain, so the cap keeps meaning "this many
             display units" rather than "this many scene units". */
          float cap = mix( AREA_LUM, RING_LUM, clamp( lightShare * 1.7, 0.0, 1.0 ) );
          float lum = dot( acc, vec3( 0.2126, 0.7152, 0.0722 ) );
          /* Max-channel rail on top of the luma cap: a deeply saturated tint has
             a low luminance for a high red channel, so a luma-only cap still
             lets R clip — and a clipped channel is what drags the grade's
             highlight desaturation into turning the read cream-white. */
          float mxc = max( acc.r, max( acc.g, acc.b ) );
          acc *= min( 1.0, min( cap / max( lum, 1e-4 ), cap * 1.9 / max( mxc, 1e-4 ) ) );
          gl_FragColor = vec4( acc * uExpNorm, a );
        }`,
    });

    const mesh = new THREE.Mesh(this.batch.geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.userData.noGBuffer = true;
    mesh.userData.occluder = false;
    mesh.userData.noOcclude = true;
    this.mesh = mesh;
    this.group.add(mesh);
    this.engine.scene.add(this.group);
  }

  _groundY(x, z) {
    const t = this.engine.get('terrain');
    if (t && !t.__dead && typeof t.heightAt === 'function') {
      const y = t.heightAt(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  /**
   * Add or refresh a ground read.
   * @param {object} s {uid, shape, x, z, yaw, radius, inner, length, width,
   *                    angle, color, alpha, duration, follow, sweep, kind}
   */
  show(s) {
    if (!s) return null;
    const uid = s.uid ?? `g${++this._seq}`;
    let it = this.items.find((i) => i.uid === uid);
    if (!it) {
      if (this.items.length >= MAX_IND) {
        // drop the oldest cosmetic pulse before dropping a real telegraph
        let vi = this.items.findIndex((i) => i.kind === 'pulse');
        if (vi < 0) vi = 0;
        this.items.splice(vi, 1);
      }
      it = { uid };
      this.items.push(it);
    }
    it.kind = s.kind ?? 'telegraph';
    it.shape = s.shape ?? SHAPE.CIRCLE;
    it.x = num(s.x, 0);
    it.z = num(s.z, 0);
    it.y = Number.isFinite(s.y) ? s.y : this._groundY(it.x, it.z);
    it.yaw = num(s.yaw, 0);
    it.radius = Math.max(0.2, num(s.radius, 1));
    it.inner = clamp01(num(s.inner, 0));
    it.length = num(s.length, it.radius);
    it.width = Math.max(0.1, num(s.width, it.radius));
    it.angle = num(s.angle, 1.2);
    it.color = new THREE.Color(s.color ?? 0xff5a22);
    /* Callers author `alpha` as "how loud is this read", 0..1. Ceiling it: past
       ~0.7 a ground read starts erasing the floor it is drawn on, which is the
       one thing a telegraph must never do. */
    it.alpha = clamp(num(s.alpha, 0.4), 0, 0.72);
    it.t0 = this.engine.clock.elapsed;
    it.duration = Math.max(0.06, num(s.duration, 0.6));
    it.follow = s.follow ?? null;
    it.sweep = s.sweep !== false;
    it.fadeIn = num(s.fadeIn, 0.09);
    it.hold = num(s.hold, 0);
    it.dead = false;
    it.prog = 0;
    return it;
  }

  update2(uid, x, z, yaw, progress) {
    const it = this.items.find((i) => i.uid === uid);
    if (!it) return;
    if (Number.isFinite(x)) { it.x = x; it.y = this._groundY(x, z); }
    if (Number.isFinite(z)) it.z = z;
    if (Number.isFinite(yaw)) it.yaw = yaw;
    if (Number.isFinite(progress)) it.forceProg = progress;
  }

  hide(uid, flash = false) {
    const i = this.items.findIndex((x) => x.uid === uid);
    if (i < 0) return;
    const it = this.items[i];
    if (flash) {
      // the strike itself: snap the read to full, then blow it out fast
      it.kind = 'flash';
      it.t0 = this.engine.clock.elapsed;
      it.duration = 0.16;
      it.forceProg = 1;
    } else {
      this.items.splice(i, 1);
    }
  }

  /** One-shot expanding shock ring. */
  pulse(x, z, radius = 1.5, color = 0xffd0a0, life = 0.34) {
    return this.show({
      kind: 'pulse', shape: SHAPE.PULSE, x, z,
      radius: clamp(radius, 0.4, 9), color, alpha: 0.9, duration: life,
      fadeIn: 0.0,
    });
  }

  /** Persistent soft-lock reticle; call every frame with the current target. */
  reticle(x, z, radius, color = 0x9fd9ff) {
    const it = this.show({
      uid: '__lock', kind: 'lock', shape: SHAPE.RETICLE, x, z,
      radius: Math.max(0.55, radius), color, alpha: 0.62, duration: 0.35, fadeIn: 0.12,
    });
    return it;
  }
  clearReticle() { this.hide('__lock'); }

  update(dt, elapsed) {
    if (!this.batch) return;
    const A = this.batch.attrs;
    const C = A.aCentre.array, S = A.aSize.array, Y = A.aYaw.array;
    const K = A.aColor.array, P = A.aParams.array, F = A.aFade.array;
    let n = 0;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const age = elapsed - it.t0;
      if (age > it.duration + it.hold) { this.items.splice(i, 1); continue; }

      /* follow a moving caster */
      if (it.follow) {
        const p = it.follow.position ?? it.follow;
        if (p && Number.isFinite(p.x)) {
          it.x = p.x; it.z = p.z;
          it.y = this._groundY(it.x, it.z);
          if (Number.isFinite(it.follow.yaw) && it.followYaw !== false) it.yaw = it.follow.yaw;
        }
      }

      const u = clamp01(age / it.duration);
      const prog = Number.isFinite(it.forceProg) ? it.forceProg : (it.sweep ? u : 1);
      /* `fade` is the master coverage the shader scales every layer by. It is
         hard-capped at 0.92: a ground read that reaches full opacity stops being
         a read of the ground and becomes a hole in the frame. */
      let fade = it.alpha;
      if (it.fadeIn > 0) fade *= clamp01(age / it.fadeIn);
      if (it.kind === 'pulse') fade = it.alpha;
      else if (it.kind === 'flash') fade = it.alpha * (1 - u) * 1.15;
      else if (it.kind === 'residual') fade = it.alpha * Math.pow(1 - u, 1.35);
      else if (age > it.duration) fade *= clamp01(1 - (age - it.duration) / Math.max(0.08, it.hold));
      // danger telegraphs pulse harder as the strike approaches
      if (it.kind === 'telegraph') fade *= 0.78 + 0.34 * u + 0.10 * Math.sin(elapsed * 13 + it.yaw);
      fade = Math.min(fade, 0.92);
      if (fade <= 0.004 || n >= MAX_IND) continue;

      const o3 = n * 3, o2 = n * 2, o4 = n * 4;
      C[o3] = it.x; C[o3 + 1] = it.y + 0.055; C[o3 + 2] = it.z;

      let sx = it.radius * 2, sz = it.radius * 2, yaw = it.yaw;
      let p0 = it.inner, p1 = 0;
      if (it.shape === SHAPE.CONE) {
        sx = it.length * 2; sz = it.length * 2;
        p0 = clamp(it.angle * 0.5, 0.05, Math.PI);
      } else if (it.shape === SHAPE.LINE) {
        sx = it.length; sz = it.width;
        // the quad's local +X spans -1..1, so the rect origin sits at its end
        C[o3] = it.x + Math.cos(it.yaw) * it.length * 0.5;
        C[o3 + 2] = it.z + Math.sin(it.yaw) * it.length * 0.5;
        C[o3 + 1] = this._groundY(C[o3], C[o3 + 2]) + 0.055;
        p0 = 1;
      } else if (it.shape === SHAPE.RING) {
        p0 = clamp01(it.inner);
      }

      S[o2] = sx; S[o2 + 1] = sz;
      Y[n] = yaw;
      K[o3] = it.color.r; K[o3 + 1] = it.color.g; K[o3 + 2] = it.color.b;
      P[o4] = it.shape; P[o4 + 1] = clamp01(prog); P[o4 + 2] = p0; P[o4 + 3] = p1;
      F[n] = clamp01(fade);
      n++;
    }

    this.batch.geo.instanceCount = n;
    if (n > 0) {
      A.aCentre.needsUpdate = true; A.aSize.needsUpdate = true; A.aYaw.needsUpdate = true;
      A.aColor.needsUpdate = true; A.aParams.needsUpdate = true; A.aFade.needsUpdate = true;
    }
    this.mesh.visible = n > 0;
    this.mat.uniforms.uTime.value = elapsed;
    // Read per-frame rather than on a scenario hook: the pipeline is the last
    // manifest module, so at applyScenario time this value is not published yet.
    const norm = this.engine.vfxExposureNorm;
    this.mat.uniforms.uExpNorm.value = Number.isFinite(norm) ? clamp(norm, 0.25, 1.0) : 1.0;
    void dt;
  }

  reset() {
    this.items.length = 0;
    if (this.batch) this.batch.geo.instanceCount = 0;
  }

  dispose() {
    this.reset();
    try {
      this.engine.scene.remove(this.group);
      this.batch?.geo.dispose();
      this.mat?.dispose();
    } catch { /* noop */ }
  }
}

export { SHAPE };

/* ================================================================== *
 * AbilityFX — the abilities' own light
 * ================================================================== *
 * Deliberately thin. VFXSystem owns particles, smoke and sparks; this is only
 * the part an ability cannot exist without — the thing that is in flight, the
 * beam that is being channelled, the arc the spin is cutting. Three shared
 * additive materials, three draw calls, all pooled.
 */

const MAX_PROJ = 12;

export class AbilityFX {
  constructor(engine) {
    this.engine = engine;
    this.group = new THREE.Group();
    this.group.name = 'combat:fx';
    this.group.matrixAutoUpdate = false;
    this.projectiles = [];
    this.beam = null;
    this.whirl = null;
    this.enabled = true;
  }

  init() {
    /* ---- projectiles: instanced billboard shards ---- */
    this.projBatch = quadBatch(MAX_PROJ * 3, [
      ['aPos', 3], ['aColor', 3], ['aMeta', 4],   // size, alpha, spin, kind
    ]);
    this.projMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uRight: { value: new THREE.Vector3(1, 0, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) } },
      vertexShader: /* glsl */`
        attribute vec3 aPos; attribute vec3 aColor; attribute vec4 aMeta;
        uniform vec3 uRight; uniform vec3 uUp;
        varying vec2 vUv; varying vec3 vC; varying float vA;
        void main() {
          vUv = uv * 2.0 - 1.0; vC = aColor; vA = aMeta.y;
          float c = cos( aMeta.z ), s = sin( aMeta.z );
          vec2 p = vec2( position.x * c - position.y * s, position.x * s + position.y * c ) * aMeta.x;
          vec3 wp = aPos + uRight * p.x + uUp * p.y;
          gl_Position = projectionMatrix * viewMatrix * vec4( wp, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        varying vec2 vUv; varying vec3 vC; varying float vA;
        void main() {
          // a struck spark: hot elongated core, soft bloom halo
          float d = length( vUv * vec2( 1.0, 2.2 ) );
          float core = smoothstep( 0.55, 0.0, d );
          float halo = smoothstep( 1.15, 0.15, length( vUv ) );
          float a = clamp( core * 1.0 + halo * 0.30, 0.0, 1.0 ) * vA;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( vC * ( 0.45 + core * 1.35 ) * a, a );
        }`,
    });
    const pm = new THREE.Mesh(this.projBatch.geo, this.projMat);
    pm.frustumCulled = false;
    pm.renderOrder = 12;
    pm.userData.noGBuffer = true;
    pm.userData.occluder = false;
    this.projMesh = pm;
    this.group.add(pm);

    /* ---- beam: a camera-facing ribbon, shaped entirely in the shader.
       A tube would be wrong here: an open cylinder has every vertex at the same
       radius, so there is no radial coordinate to build a hot core from, and a
       capped one reads as a solid rod. A quad whose second axis is rebuilt each
       frame perpendicular to the view gives a real core-to-edge falloff. ---- */
    const bg = new THREE.PlaneGeometry(1, 2, 1, 1);
    bg.translate(0.5, 0, 0);            // origin at the caster's hand, +X forward
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 }, uGain: { value: 0 },
        uCore: { value: new THREE.Color(0xe7d4ff) }, uEdge: { value: new THREE.Color(0x7a2fd8) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv; varying float vR;
        void main() {
          vUv = uv;
          vR = abs( uv.y * 2.0 - 1.0 );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uTime; uniform float uGain; uniform vec3 uCore; uniform vec3 uEdge;
        varying vec2 vUv; varying float vR;
        void main() {
          float along = vUv.x;                       // 0 at the hand, 1 at the tip
          float radial = clamp( vR, 0.0, 1.0 );
          float body = pow( 1.0 - radial, 2.0 );
          // travelling striations so the channel reads as energy, not a tube
          float flow = 0.72 + 0.28 * sin( along * 46.0 - uTime * 22.0 );
          float taper = smoothstep( 0.0, 0.06, along ) * ( 1.0 - along * 0.42 );
          float a = body * taper * flow * uGain;
          if ( a < 0.004 ) discard;
          vec3 c = mix( uEdge, uCore, body * body );
          gl_FragColor = vec4( c * a * 1.15, a );
        }`,
    });
    this.beam = new THREE.Mesh(bg, this.beamMat);
    this.beam.frustumCulled = false;
    this.beam.visible = false;
    this.beam.renderOrder = 11;
    this.beam.userData.noGBuffer = true;
    this.beam.userData.occluder = false;
    this.group.add(this.beam);

    /* ---- spin arc: a flat ribbon around the hero. Exactly 180°: the shader
       recovers "distance along the arc" with atan2, and any sweep past π wraps
       the branch cut and tears the ribbon in half. ---- */
    const wg = new THREE.RingGeometry(0.80, 1.0, 44, 1, 0, Math.PI);
    wg.rotateX(-Math.PI * 0.5);
    this.whirlMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: {
        uGain: { value: 0 }, uTime: { value: 0 },
        uCore: { value: new THREE.Color(0xdce9ff) }, uEdge: { value: new THREE.Color(0x3f6ba8) },
      },
      vertexShader: /* glsl */`
        varying float vT; varying float vR;
        void main() {
          vR = length( position.xz );
          vT = clamp( -atan( position.z, position.x ) / 3.14159265, 0.0, 1.0 );
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform float uGain; uniform float uTime; uniform vec3 uCore; uniform vec3 uEdge;
        varying float vT; varying float vR;
        void main() {
          /* A motion smear, not a disc of light. The ribbon is a thin band whose
             brightness collapses toward the tail, so what reads is the blade's
             path over the last ~60° — anything wider blooms into a white plate
             and swallows the silhouette it is supposed to sell. */
          float t = vT;                                     // along the arc
          float band = smoothstep( 0.0, 0.30, vR - 0.80 ) * smoothstep( 1.0, 0.94, vR );
          float head = pow( clamp( t, 0.0, 1.0 ), 4.5 );    // brightest at the blade
          float streak = 0.72 + 0.28 * sin( t * 22.0 + uTime * 26.0 );
          float a = head * ( 0.28 + band * 0.72 ) * streak * uGain * 0.62;
          if ( a < 0.004 ) discard;
          gl_FragColor = vec4( mix( uEdge, uCore, head * 0.8 ) * a * 0.85, a );
        }`,
    });
    this.whirl = new THREE.Mesh(wg, this.whirlMat);
    this.whirl.frustumCulled = false;
    this.whirl.visible = false;
    this.whirl.renderOrder = 11;
    this.whirl.userData.noGBuffer = true;
    this.whirl.userData.occluder = false;
    this.group.add(this.whirl);

    this.engine.scene.add(this.group);
  }

  /** Spawn a flying projectile visual (the sim lives in CombatSystem). */
  addProjectile(p) {
    if (this.projectiles.length >= MAX_PROJ) this.projectiles.shift();
    this.projectiles.push(p);
  }
  removeProjectile(p) {
    const i = this.projectiles.indexOf(p);
    if (i >= 0) this.projectiles.splice(i, 1);
  }

  /**
   * Place the channelled beam this frame. `gain` 0 hides it. The ribbon's
   * second axis is rebuilt every frame perpendicular to both the beam and the
   * view, so it always presents its full width to the camera.
   */
  setBeam(ox, oy, oz, dx, dy, dz, length, radius, gain, color) {
    if (!this.beam) return;
    if (gain <= 0.01 || length <= 0.05) { this.beam.visible = false; return; }
    this.beam.visible = true;
    const F = _bx.set(dx, dy, dz);
    if (F.lengthSq() < 1e-6) F.set(0, 0, 1);
    F.normalize();
    const cam = this.engine.camera;
    _by.set(0, 1, 0);
    if (cam) _by.set(ox - cam.position.x, oy - cam.position.y, oz - cam.position.z).normalize();
    _bz.crossVectors(F, _by);
    if (_bz.lengthSq() < 1e-6) _bz.set(0, 1, 0).cross(F);
    _bz.normalize();
    _by.crossVectors(_bz, F).normalize();
    // columns: X = forward, Y = screen-perpendicular width, Z = normal
    this.beam.matrix.set(
      F.x * length, _by.x * radius, _bz.x, ox,
      F.y * length, _by.y * radius, _bz.y, oy,
      F.z * length, _by.z * radius, _bz.z, oz,
      0, 0, 0, 1
    );
    this.beam.matrixAutoUpdate = false;
    this.beam.matrixWorldNeedsUpdate = true;
    this.beamMat.uniforms.uGain.value = gain;
    if (color) {
      this.beamMat.uniforms.uEdge.value.setHex(color);
      this.beamMat.uniforms.uCore.value.setHex(color).lerp(WHITE, 0.62);
    }
  }

  /** Place the spin ribbon. `phase` in radians. */
  setWhirl(x, y, z, radius, phase, gain, color) {
    if (!this.whirl) return;
    if (gain <= 0.01) { this.whirl.visible = false; return; }
    this.whirl.visible = true;
    this.whirl.position.set(x, y, z);
    this.whirl.rotation.y = phase;
    this.whirl.scale.setScalar(Math.max(0.3, radius));
    this.whirlMat.uniforms.uGain.value = clamp01(gain) * 0.8;
    if (color) {
      this.whirlMat.uniforms.uEdge.value.setHex(color).multiplyScalar(0.30);
      this.whirlMat.uniforms.uCore.value.setHex(color).lerp(WHITE, 0.35);
    }
  }

  update(dt, elapsed) {
    const cam = this.engine.camera;
    if (cam) {
      const m = cam.matrixWorld.elements;
      this.projMat.uniforms.uRight.value.set(m[0], m[1], m[2]);
      this.projMat.uniforms.uUp.value.set(m[4], m[5], m[6]);
    }
    this.beamMat.uniforms.uTime.value = elapsed;
    this.whirlMat.uniforms.uTime.value = elapsed;

    /* projectile visuals: a head plus two trailing echoes */
    const A = this.projBatch.attrs;
    const pos = A.aPos.array, col = A.aColor.array, meta = A.aMeta.array;
    let n = 0;
    for (const p of this.projectiles) {
      _c.setHex(p.color ?? 0xcbb4ff);
      for (let k = 0; k < 3; k++) {
        if (n >= MAX_PROJ * 3) break;
        const back = k * 0.055;
        const o3 = n * 3, o4 = n * 4;
        pos[o3] = p.x - p.dx * p.speed * back;
        pos[o3 + 1] = p.y - p.dy * p.speed * back;
        pos[o3 + 2] = p.z - p.dz * p.speed * back;
        col[o3] = _c.r; col[o3 + 1] = _c.g; col[o3 + 2] = _c.b;
        meta[o4] = (p.size ?? 0.55) * (1 - k * 0.24);
        meta[o4 + 1] = clamp01(p.alpha ?? 1) * (1 - k * 0.34);
        meta[o4 + 2] = (p.spin ?? 0) - k * 0.5;
        meta[o4 + 3] = 0;
        n++;
      }
    }
    this.projBatch.geo.instanceCount = n;
    if (n > 0) {
      A.aPos.needsUpdate = true; A.aColor.needsUpdate = true; A.aMeta.needsUpdate = true;
    }
    this.projMesh.visible = n > 0;
    void dt;
  }

  reset() {
    this.projectiles.length = 0;
    if (this.beam) this.beam.visible = false;
    if (this.whirl) this.whirl.visible = false;
    if (this.projBatch) this.projBatch.geo.instanceCount = 0;
  }

  dispose() {
    this.reset();
    try {
      this.engine.scene.remove(this.group);
      this.projBatch?.geo.dispose();
      this.projMat?.dispose();
      this.beam?.geometry.dispose(); this.beamMat?.dispose();
      this.whirl?.geometry.dispose(); this.whirlMat?.dispose();
    } catch { /* noop */ }
  }
}

const WHITE = new THREE.Color(0xffffff);
const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
