/**
 * THE NINTH VIGIL — Town: the waypoint settlement.
 *
 * Owns everything built by human hands in the `town` biome: the buildings, the
 * curtain wall and its gate, the market, the street network, the waypoint shrine
 * that anchors the composition, and the practical lights that come with all of
 * it. Also spawns the townsfolk (see chars/NPCs.js), because the `hub` scenario
 * asks for six NPCs and Bestiary only knows how to make monsters.
 *
 * Budget strategy — the project is already over its draw-call budget, so this
 * module is built to be almost free:
 *
 *   • Every piece of geometry in the town is authored, transformed into world
 *     space and then MERGED into one buffer per material. A ten-building
 *     village, a wall, a gatehouse, five stalls, a well and a shrine come out as
 *     ~11 draw calls total instead of ~900.
 *   • Repeated small elements that must stay separable (palisade stakes) are
 *     instanced.
 *   • Only eight textured materials exist, each on a strict three-sampler diet
 *     (map + normal + roughness) — see town/TownMaterials.js. Six samplers per
 *     material is what white-screened the project before.
 *   • Practicals are motivated: every light this module adds sits inside geometry
 *     it also built (a lantern with a glazed pane, a brazier with coals, a forge,
 *     a rune). There is no bare glowing orb anywhere.
 *
 * Registration: this module self-registers `npcs` from `init()` via
 * `engine.register(id, instance)` so `src/game/modules.js` (integrator-owned)
 * does not have to change to get townsfolk.
 */

import * as THREE from 'three';
import { planTown } from './town/Layout.js';
import { buildHouse } from './town/Building.js';
import { buildWall } from './town/Wall.js';
import { buildMarket } from './town/Market.js';
import { buildLandmark } from './town/Landmark.js';
import { buildStreets } from './town/Street.js';
import { TownMaterials } from './town/TownMaterials.js';
import { Assembler, projectUV, bakeArch, finish, triCount } from './town/Geo.js';
import { SmokeField, FlameField } from './town/Effects.js';
import { NPCs } from '../chars/NPCs.js';

/** Materials whose UVs are authored parametrically and must not be reprojected. */
const AUTHORED_UV = new Set(['shingle', 'awning']);
/**
 * Materials that never cast.
 *
 * Thin glazing reads better lit through than shadowed, and `cobble` is the ground
 * paving: it is flat on the terrain, so it can only ever shadow itself. Excusing
 * it costs nothing visually and saves 4 cascade passes plus 12 cube faces of the
 * heaviest buffer in the town.
 */
const NO_CAST = new Set([
  'glow:window', 'glow:lamp', 'glow:forge', 'glow:rune', 'glow:glyph', 'glow:coal', 'glow:shaft',
  'cobble', 'iron',
]);

export class Town {
  static id = 'town';

  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) {
    this.engine = engine;
    this.enabled = true;
    this.ready = false;
    this.active = false;

    this.group = new THREE.Group();
    this.group.name = 'Town';
    this.group.matrixAutoUpdate = false;

    this.mats = null;
    this.plan = null;
    this.npcs = null;
    this.smoke = null;
    this.flames = null;

    this._meshes = [];
    this._geos = [];
    this._practicals = [];
    this._fixtures = [];
    this._carved = [];
    this._triCount = 0;
    this._spin = null;
    this._spinY = 0;
    this._offs = [];
    this._scenarioName = null;
  }

  /* ================================================================ *
   * lifecycle
   * ================================================================ */

  async init() {
    this.mats = new TownMaterials(this.engine);
    this.engine.scene.add(this.group);

    /* Self-register the townsfolk. Engine.register is idempotent by id, so if a
       future manifest lists NPCs explicitly this is a no-op. */
    try {
      if (!this.engine.get('npcs')) {
        const npcs = new NPCs(this.engine);
        this.engine.register('npcs', npcs);
        await npcs.init?.();
        this.npcs = npcs;
      } else {
        this.npcs = this.engine.get('npcs');
      }
    } catch (e) {
      console.error('[town] NPC module failed —', e);
      this.npcs = null;
    }

    this.ready = true;

    // A late-registered module misses the scenario that was applied during boot,
    // so catch up if one is already live.
    const sc = this.engine.scenario;
    if (sc && sc.name && this._scenarioName !== sc.name) {
      try { await this.applyScenario(sc.name, sc); } catch (e) { console.error('[town] catch-up', e); }
    }
  }

  dispose() {
    for (const off of this._offs) { try { off?.(); } catch { /* noop */ } }
    this._offs.length = 0;
    this._clear();
    this.mats?.dispose();
    this.mats = null;
    this.group.removeFromParent();
    this.ready = false;
  }

  /* ================================================================ *
   * scenario
   * ================================================================ */

  async applyScenario(name, cfg = {}) {
    if (!this.ready) return;
    this._scenarioName = name;
    const biome = cfg?.env?.biome;
    if (biome !== 'town') {
      this._clear();
      this.active = false;
      this.group.visible = false;
      return;
    }
    try {
      this._clear();
      this.group.visible = true;
      this._build(name, cfg);
      this.active = true;
    } catch (e) {
      console.error('[town:applyScenario]', e);
      this.active = false;
    }
  }

  /* ================================================================ *
   * build
   * ================================================================ */

  _build(name, cfg) {
    const engine = this.engine;
    const terrain = engine.get('terrain');
    const probe = {
      heightAt: (x, z) => {
        const y = terrain && !terrain.__dead ? terrain.heightAt(x, z) : 0;
        return Number.isFinite(y) ? y : 0;
      },
      slopeAt: (x, z) => (terrain && !terrain.__dead && terrain.slopeAt ? terrain.slopeAt(x, z) : 0),
    };
    const rand = engine.freshRand(`town:${name}`);
    const yaw = cfg?.camera?.yaw ?? 35;
    const plan = planTown({ yaw, rand, probe });
    this.plan = plan;

    /* ---- world-space assembly ---- */
    const W = new Assembler();
    const lights = [];
    const smoke = [];

    /* streets first: they define the ground everything else sits on */
    try {
      buildStreets(W, { plan, probe, seed: 2201 });
    } catch (e) { console.error('[town] streets', e); }

    /* buildings */
    for (const B of plan.buildings) {
      try {
        const out = buildHouse(B);
        const piles = out.A.piles();
        const c = Math.cos(B.rotY), s = Math.sin(B.rotY);
        for (const [mat, geo] of piles) {
          // bake building-local occlusion BEFORE the world transform, so the
          // ground/eave gradients are measured in the building's own frame
          if (!AUTHORED_UV.has(mat) && !mat.startsWith('glow:')) projectUV(geo, 1);
          if (!mat.startsWith('glow:')) {
            bakeArch(geo, {
              // Softer than the first pass. Baked occlusion multiplies the albedo
              // BEFORE the (very weak, backlit) dusk key touches it, so a 0.46
              // ground term plus a 0.34 eave term plus a 0.34 cavity term
              // compounded to roughly a quarter of the authored value and the
              // walls went to black. Enough to read as contact occlusion, not
              // enough to erase the surface.
              seed: B.seed, groundY: 0, groundH: 0.7 + B.plinth, groundK: 0.38,
              eaveY: out.top + 0.1, eaveK: 0.26, eaveH: 1.5,
              cavity: 0.29, blotch: 0.15, blotchFreq: 0.85,
              damp: mat === 'ashlar' || mat === 'plaster' ? 0.5 : 0.22, dampH: 1.1,
              // Dust settles on up-facing surfaces and is the only thing lifting
              // the roof planes out of the backlit shade — it doubles as the
              // aerial-perspective haze on the far roofs.
              dust: mat === 'shingle' ? 0.34 : 0.12,
              center: [0, 0],
            });
          }
          W.add(mat, geo, { rotY: B.rotY, pos: [B.x, B.groundY, B.z] });
        }
        for (const L of out.lights) {
          lights.push({
            ...L,
            x: B.x + L.x * c + L.z * s,
            z: B.z - L.x * s + L.z * c,
            y: B.groundY + L.y,
          });
        }
        for (const S of out.smoke) {
          smoke.push({
            x: B.x + S.x * c + S.z * s,
            z: B.z - S.x * s + S.z * c,
            y: B.groundY + S.y,
            r: S.r, warm: !!S.warm,
          });
        }
      } catch (e) {
        console.error(`[town] building ${B.id} failed —`, e);
      }
    }

    /* wall + gate */
    try {
      const out = buildWall(W, { plan, probe, seed: 8801 });
      for (const L of out.lights) lights.push(L);
      this._instanced = out.instanced ?? null;
    } catch (e) { console.error('[town] wall', e); }

    /* market */
    try {
      const out = buildMarket(W, { plan, probe, seed: 5501 });
      for (const L of out.lights) lights.push(L);
      for (const S of out.smoke ?? []) smoke.push(S);
    } catch (e) { console.error('[town] market', e); }

    /* the landmark: the waypoint shrine */
    try {
      const out = buildLandmark(W, { plan, probe, seed: 7717 });
      for (const L of out.lights) lights.push(L);
      // the glyph plates orbit, so they cannot be merged into the static pile
      if (out.spin && !out.spin.isEmpty()) {
        this._spin = new THREE.Object3D();
        this._spin.name = 'town.shrineOrbit';
        this._spinY = out.spinAt[1];
        this._spin.position.set(out.spinAt[0], out.spinAt[1], out.spinAt[2]);
        for (const [matName, geo] of out.spin.piles()) {
          finish(geo);
          if (!matName.startsWith('glow:')) projectUV(geo, 1);
          const mesh = new THREE.Mesh(geo, matName.startsWith('glow:') ? this._glowMat(matName) : this.mats.get(matName));
          mesh.name = `town.orbit.${matName}`;
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.frustumCulled = false;
          this._noOcclude(mesh);
          this._spin.add(mesh);
          this._meshes.push(mesh);
          this._geos.push(geo);
          this._triCount += triCount(geo);
        }
        this.group.add(this._spin);
      }
    } catch (e) { console.error('[town] landmark', e); }

    /* ---- realise: one mesh per material ---- */
    const piles = W.piles();
    for (const [matName, geo] of piles) {
      try {
        finish(geo);
        const mat = matName.startsWith('glow:') ? this._glowMat(matName) : this.mats.get(matName);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `town.${matName}`;
        mesh.castShadow = !NO_CAST.has(matName);
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;      // one buffer spans the whole town
        mesh.updateMatrix();
        this._noOcclude(mesh);
        if (matName === 'glow:window' || matName === 'glow:lamp') mesh.renderOrder = 1;
        this.group.add(mesh);
        this._meshes.push(mesh);
        this._geos.push(geo);
        this._triCount += triCount(geo);
      } catch (e) {
        console.error(`[town] mesh "${matName}" failed —`, e);
      }
    }
    if (this._instanced) {
      for (const im of this._instanced) {
        try {
          im.mesh.material = this.mats.get(im.mat);
          im.mesh.matrixAutoUpdate = false;
          im.mesh.updateMatrix();
          this._noOcclude(im.mesh);
          this.group.add(im.mesh);
          this._meshes.push(im.mesh);
          this._triCount += triCount(im.mesh.geometry) * im.mesh.count;
        } catch (e) { console.error('[town] instanced', e); }
      }
    }

    /* ---- effects ---- */
    try {
      this.smoke = new SmokeField(smoke);
      if (this.smoke.mesh) {
        this._noOcclude(this.smoke.mesh);
        this.group.add(this.smoke.mesh);
        this._meshes.push(this.smoke.mesh);
      }
    } catch (e) { console.error('[town] smoke', e); this.smoke = null; }

    try {
      const flames = lights.filter((l) => l.flame).map((l) => ({ x: l.x, y: l.y, z: l.z, s: l.flameScale ?? 1 }));
      this.flames = new FlameField(flames);
      if (this.flames.mesh) {
        this._noOcclude(this.flames.mesh);
        this.group.add(this.flames.mesh);
        this._meshes.push(this.flames.mesh);
      }
    } catch (e) { console.error('[town] flames', e); this.flames = null; }

    /* ---- lights: every one of them sits in a fixture built above ---- */
    this._addLights(lights);

    /* ---- foreground fires, fixtures borrowed from Props ---- */
    try { this._placeFires(plan); } catch (e) { console.error('[town] fires', e); }

    /* ---- keep the dressing module's clutter out of our walls ---- */
    this._carveProps();

    /* ---- townsfolk ---- */
    try {
      this.npcs?.populate?.(plan, cfg);
    } catch (e) { console.error('[town] npcs', e); }

    console.info(
      `[town] ${plan.buildings.length} buildings, ${this._meshes.length} draw calls, ` +
      `${(this._triCount / 1000).toFixed(0)}k tris, ${this._practicals.length} practicals`
    );
  }

  /**
   * Opt every town mesh out of CameraRig's occluder fade.
   *
   * The rig dissolves anything that comes between the lens and the hero's chest,
   * which is exactly right for a single building and catastrophic for a merged
   * one: our per-material buffers span the entire settlement, so their AABBs
   * always contain that segment and the rig ghosted the whole town at once —
   * every wall went alpha-hashed AND kept casting, which stippled the shadow map
   * across the entire frame. The composition is laid out so nothing stands
   * between the camera and the plaza in the first place, so the honest fix is to
   * decline the service. `userData.occluder = false` / `noOcclude` is the rig's
   * own documented opt-out; `ignoreOccluder` is belt and braces.
   */
  _noOcclude(mesh) {
    mesh.userData.occluder = false;
    mesh.userData.noOcclude = true;
    try { this.engine.get('camera')?.ignoreOccluder?.(mesh); } catch { /* optional */ }
  }

  /**
   * Emissive bank.
   *
   * These numbers ARE the frame's value structure. The hub sun is a 2.1-intensity
   * dusk key pointing at the lens, so the town supplies its own light: the
   * windows, the lamps, the forge and the shrine are the only things in shot that
   * can put a highlight above mid-grey. At the shipped 1.3-2.6 they sat barely
   * over the bloom threshold and the frame measured 48% pure black with p50 at
   * 0.023. Each of these is fire, lava-hot iron or magic, which is exactly the
   * list KNOWN_ISSUES.md permits above 1.0 — and every one of them is a small,
   * localised area, so bloom stays a halo around a source instead of a full-frame
   * haze.
   */
  _glowMat(key) {
    switch (key) {
      case 'glow:window': return this.mats.glow('window', { color: 0xff9a3e, intensity: 2.35, base: 0x2a1707, rough: 0.42 });
      // A lamp head is 10 cm of glass filling ~5 px. Anything much over 2 and the
      // tonemapper clips all three channels, which turns the lantern into exactly
      // the white orb KNOWN_ISSUES.md calls an instant fail — the glaze has to
      // keep its amber and its shape, and the bloom halo does the "brightness".
      case 'glow:lamp': return this.mats.glow('lamp', { color: 0xffb765, intensity: 2.05, base: 0x35200c, rough: 0.35 });
      case 'glow:forge': return this.mats.glow('forge', { color: 0xff5a14, intensity: 4.0, base: 0x241006, rough: 0.72 });
      /*
       * ACES desaturates hard as a channel approaches 1.0, so a violet with a
       * dominant blue channel goes WHITE long before it goes bright: at 1.85 and
       * again at 1.15 the carved channels rendered as bars of white paint. Held
       * under 0.6 linear in every channel the arcane accent survives the
       * tonemapper — the *brightness* of the shrine comes from its point light
       * raking the stone and from the bloom halo, not from clipping the emissive.
       */
      case 'glow:rune': return this.mats.glow('rune', { color: 0x7a4fe0, intensity: 0.86, base: 0x140f26, rough: 0.4 });
      // The orbiting glyph plates are 20 cm tall and sit against the sky-lit face
      // of the shaft; at the shaft's own emissive level they clipped to white and
      // read as floating paper, not as carved slate lit from within.
      case 'glow:glyph': return this.mats.glow('glyph', { color: 0x6a46cc, intensity: 0.58, base: 0x140f26, rough: 0.42 });
      case 'glow:coal': return this.mats.glow('coal', { color: 0xff7024, intensity: 2.5, base: 0x1c0d05, rough: 0.85 });
      // Not a glow at all — the inside of a well shaft, a slack tub, a trough.
      // Dark, smooth and unlit is exactly what a hole full of water looks like,
      // and it costs no texture units.
      case 'glow:shaft': return this.mats.glow('shaft', { color: 0x000000, intensity: 0, base: 0x05070a, rough: 0.10 });
      default: return this.mats.glow('window', {});
    }
  }

  /**
   * Realise the foreground watch fires through `Props.placeFixture()`.
   *
   * `placeFixture` builds the fixture out of Props' own instance pools and its own
   * shared flame material, so a campfire with logs and stones, a coal brazier and
   * a torch post cost the town ZERO draw calls and zero texture units.
   *
   * ORDER MATTERS, and getting it wrong doubles the light. `_realizeFixture` looks
   * for an already-registered practical within 0.75 m and *re-seats it onto the
   * flame* (`_adoptLightNear`); only if it finds none does it add a light of its
   * own. Register first, then place, and the town ends up with one light, at the
   * fire, inside a fixture — which is the whole contract. Place first and Props
   * adds its own on top of ours, which is what blew the watch fire's pool of
   * cobbles to flat white on the previous pass.
   *
   * If Props declines (it returns null while its own dressing pass is pending) the
   * practical is withdrawn again rather than left burning in mid-air: a light with
   * no lamp is the exact "floating glowing orb" instant-fail in KNOWN_ISSUES.md.
   */
  _placeFires(plan) {
    const props = this.engine.get('props');
    const lighting = this.engine.get('lighting');
    if (!props || props.__dead || typeof props.placeFixture !== 'function') return 0;
    let n = 0;
    for (const F of plan.fires ?? []) {
      let p = null;
      try {
        p = lighting && !lighting.__dead ? lighting.addTorch?.({
          position: [F.x, F.ground + F.y, F.z],
          color: F.color, intensity: F.i, radius: F.r, flicker: F.fl,
          type: F.kind === 'post' ? 'torch' : F.kind,
          priority: F.pr, shadow: false,
        }) : null;
      } catch { p = null; }
      let handle = null;
      try {
        handle = props.placeFixture(F.kind, [F.x, F.ground, F.z], { rotY: F.rotY, seed: F.seed });
      } catch { handle = null; }
      if (!handle) {
        try { if (p) lighting?.removeTorch?.(p); } catch { /* noop */ }
        continue;
      }
      /*
       * A handle with no instance slots is a fixture with no BODY: Props' pool for
       * that kind was already full (its own town dressing places sixteen fixtures
       * before we ask), so all we got was the flame and the light. That is the
       * floating-orb failure again, so withdraw the light and move on — the fires
       * that matter are authored as town geometry instead.
       */
      if (!handle.slots?.length) {
        try { if (p) lighting?.removeTorch?.(p); } catch { /* noop */ }
        console.warn(`[town] props pool full for "${F.kind}" — fire skipped`);
        continue;
      }
      this._fixtures.push(handle);
      if (p) this._practicals.push(p);
      n++;
    }
    if (n) console.info(`[town] ${n} foreground fixtures placed through Props`);
    return n;
  }

  /**
   * Register practicals with Lighting. Every entry here was emitted by a geometry
   * builder that also produced its fixture, which is the standing requirement in
   * KNOWN_ISSUES.md ("every light needs a visible source object").
   */
  _addLights(list) {
    const lighting = this.engine.get('lighting');
    if (!lighting || lighting.__dead) return;
    // Importance-sorted: the gate braziers and the shrine are the composition,
    // so they get first claim on the shadow-capable slots.
    const sorted = list.slice().sort((a, b) => (b.priority ?? 1) - (a.priority ?? 1));
    for (const L of sorted) {
      try {
        const p = lighting.addTorch?.({
          position: [L.x, L.y, L.z],
          color: L.color,
          intensity: L.intensity ?? 8,
          radius: L.radius ?? 10,
          flicker: L.flicker ?? 0.35,
          type: L.type ?? 'torch',
          priority: L.priority ?? 1,
          shadow: L.shadow === true,
          glow: L.glow ?? false,
        });
        if (p) this._practicals.push(p);
      } catch (e) {
        console.warn('[town] light rejected —', e?.message ?? e);
      }
    }
  }

  /**
   * Props dresses the town biome with its own market clutter on a Poisson
   * scatter that knows nothing about our buildings, so a barrel can end up
   * inside a wall. `rec.hidden` is Props' own documented "not present" flag —
   * `_refreshDynamic` and `blocksAt` both honour it — so setting it and zeroing
   * the instance slots removes the clash without touching another module's code.
   */
  _carveProps() {
    const props = this.engine.get('props');
    if (!props || props.__dead || !Array.isArray(props.props)) return;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    const zones = [];
    for (const B of this.plan.buildings) {
      zones.push({ x: B.x, z: B.z, r: Math.max(B.width, B.depth) * 0.62 + 0.5 });
    }
    if (this.plan.wall) {
      const pts = this.plan.wall.pts;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 1.6));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          zones.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, r: 1.35 });
        }
      }
    }
    for (const S of this.plan.stalls) zones.push({ x: S.x, z: S.z, r: Math.max(S.span, S.depth) * 0.5 });
    for (const P of this.plan.props) zones.push({ x: P.x, z: P.z, r: 1.15 });
    if (this.plan.landmark) zones.push({ x: this.plan.landmark.x, z: this.plan.landmark.z, r: 2.7 });
    for (const R of this.plan.roads) {
      for (let i = 0; i < R.pts.length - 1; i++) {
        const a = R.pts[i], b = R.pts[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.0));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          zones.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, r: R.width * 0.24, soft: true });
        }
      }
    }

    let n = 0;
    for (const rec of props.props) {
      if (rec.hidden) continue;
      /*
        * Ground litter may creep onto a road; only solid dressing gets removed.
        *
        * The first pass carved 150 of Props' town dressing — a third of the
        * clutter in the biome — because the road corridors were 42% of a 4.8 m
        * lane wide and anything over 32 cm counted as an obstruction. That is how
        * the plaza ended up as bare paving. Only genuinely cart-blocking objects
        * (>= 55 cm) come off a street now, and the corridor is narrower.
        */
      const small = (rec.r ?? 1) < 0.72;
      for (const Z of zones) {
        if (Z.soft && small) continue;
        const dx = rec.x - Z.x, dz = rec.z - Z.z;
        const rr = Z.r + (Z.soft ? 0 : (rec.r ?? 0.5) * 0.4);
        if (dx * dx + dz * dz < rr * rr) {
          rec.hidden = true;
          try {
            for (const s of rec.slots ?? []) { s.mesh.setMatrixAt(s.idx, zero); s.mesh.instanceMatrix.needsUpdate = true; }
            for (const s of rec.lodSlots ?? []) { s.mesh.setMatrixAt(s.idx, zero); s.mesh.instanceMatrix.needsUpdate = true; }
            const c = props._contact;
            if (c?.mesh && rec.blobSlot >= 0) { c.mesh.setMatrixAt(rec.blobSlot, zero); c.mesh.instanceMatrix.needsUpdate = true; }
          } catch { /* another module's internals may move; never fatal */ }
          this._carved.push(rec);
          n++;
          break;
        }
      }
    }
    if (n) console.info(`[town] carved ${n} clashing props out of the built area`);
  }

  /* ================================================================ *
   * frame
   * ================================================================ */

  update(dt, elapsed) {
    if (!this.active || !this.enabled) return;
    this.smoke?.update(elapsed);
    this.flames?.update(elapsed);
    if (this._spin) {
      this._spin.rotation.y = elapsed * 0.11;
      this._spin.position.y = this._spinY + Math.sin(elapsed * 0.42) * 0.07;
      this._spin.updateMatrixWorld(true);
    }
  }

  /* ================================================================ *
   * queries — for AI, physics and the camera's occlusion pass
   * ================================================================ */

  /** True if a capsule of radius r at (x,z) would be inside a building or wall. */
  blocksAt(x, z, r = 0.4) {
    if (!this.active || !this.plan) return false;
    for (const B of this.plan.buildings) {
      const dx = x - B.x, dz = z - B.z;
      const c = Math.cos(B.rotY), s = Math.sin(B.rotY);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) < B.width * 0.5 + r && Math.abs(lz) < B.depth * 0.5 + r) return true;
    }
    const pts = this.plan.wall?.pts;
    if (pts) {
      const gate = this.plan.wall.gate;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const abx = b.x - a.x, abz = b.z - a.z;
        const l2 = abx * abx + abz * abz;
        let t = l2 > 1e-6 ? ((x - a.x) * abx + (z - a.z) * abz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = a.x + abx * t, pz = a.z + abz * t;
        if (Math.hypot(px - gate.x, pz - gate.z) < 2.4) continue;   // the gateway is open
        const d = Math.hypot(x - px, z - pz);
        if (d < 0.55 + r) return true;
      }
    }
    return false;
  }

  stats() {
    return {
      active: this.active,
      buildings: this.plan?.buildings.length ?? 0,
      drawCalls: this._meshes.length,
      triangles: Math.round(this._triCount),
      practicals: this._practicals.length,
      carvedProps: this._carved.length,
      materials: this.mats?.list.length ?? 0,
    };
  }

  /* ================================================================ *
   * teardown
   * ================================================================ */

  _clear() {
    const lighting = this.engine.get('lighting');
    for (const p of this._practicals) {
      try { lighting?.removeTorch?.(p); } catch { /* noop */ }
    }
    this._practicals.length = 0;

    const props = this.engine.get('props');
    for (const rec of this._carved) {
      // Props rebuilds its plan on every scenario switch, so restoring is only
      // needed if the same instance is still live.
      try {
        if (props && !props.__dead && rec.slots && rec.matrix) {
          rec.hidden = false;
          for (const s of rec.slots) { s.mesh.setMatrixAt(s.idx, rec.matrix); s.mesh.instanceMatrix.needsUpdate = true; }
        }
      } catch { /* noop */ }
    }
    this._carved.length = 0;

    for (const m of this._meshes) {
      try {
        m.removeFromParent();
        if (m.geometry && !this._geos.includes(m.geometry)) m.geometry.dispose();
      } catch { /* noop */ }
    }
    this._meshes.length = 0;
    for (const g of this._geos) { try { g.dispose(); } catch { /* noop */ } }
    this._geos.length = 0;

    try { this.smoke?.dispose(); } catch { /* noop */ }
    this.smoke = null;
    try { this.flames?.dispose(); } catch { /* noop */ }
    this.flames = null;

    try { this.npcs?.clear?.(); } catch { /* noop */ }

    try { this._spin?.removeFromParent(); } catch { /* noop */ }
    this._spin = null;
    this._instanced = null;
    this._fixtures.length = 0;
    this._triCount = 0;
    this.plan = null;
  }
}
