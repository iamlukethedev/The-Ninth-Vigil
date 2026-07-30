# THE NINTH VIGIL — Engine Contract (v1)

**Every agent MUST read this before writing code. It is the integration boundary.**

Project: a Diablo 4–class isometric action RPG in Three.js. Dark gothic, grounded,
physically-based, heavy atmosphere. No external asset downloads — **all textures,
meshes, animations, and audio are generated procedurally at runtime or build time.**

## Hard rules

1. **ES modules only.** `import * as THREE from 'three';` — three is in node_modules.
2. **You own only the files assigned to you.** Never edit another module's files,
   never edit `src/main.js`, `src/core/Engine.js`, `index.html`, or `tools/*`.
3. **No new npm dependencies.** three + vite + playwright only.
4. **No network fetches at runtime.** No CDNs, no remote textures, no fonts.
   Everything procedural or inlined as data URIs.
5. **Everything must degrade, never crash.** A module that throws must be caught
   by its own try/catch and disable itself, not kill the frame loop.
6. **60 fps at 1920x1080 is a requirement, not a goal.** Budget below.
7. Write real code. No `// TODO: implement`, no stub functions that return null,
   no placeholder cubes standing in for content you were asked to build.

## Module lifecycle

Every module is a class with this shape:

```js
export class MyModule {
  static id = 'myModule';
  /** @param {import('../core/Engine.js').Engine} engine */
  constructor(engine) { this.engine = engine; }
  async init() {}                 // build GPU resources, add to scene
  update(dt, elapsed) {}          // per-frame sim; dt is fixed (1/60) when stepping
  resize(w, h) {}                 // optional
  dispose() {}                    // release GPU resources
}
```

Register in `src/game/modules.js` (owned by the integrator).

## Engine services (available as `this.engine.<x>`)

| Service | What it is |
|---|---|
| `engine.renderer` | `THREE.WebGLRenderer` — do not replace, do not change its settings |
| `engine.scene` | root `THREE.Scene` |
| `engine.camera` | `THREE.PerspectiveCamera` — isometric-ish, driven by CameraRig |
| `engine.clock` | `{ dt, elapsed, frame }` |
| `engine.input` | `{ mouse:{x,y,ndc,worldGround}, down(btn), pressed(key), justPressed(key) }` |
| `engine.bus` | `on(evt,fn)` / `off` / `emit(evt,payload)` — the ONLY cross-module channel |
| `engine.get(id)` | fetch another registered module (may return undefined — guard it) |
| `engine.assets` | `AssetForge` — procedural texture/geometry factory (see below) |
| `engine.quality` | `{ tier:'low'\|'med'\|'high'\|'ultra', shadowRes, ssao, ssr, taa }` |
| `engine.rand(seed)` | deterministic PRNG factory. **Never use `Math.random()`** |

## Determinism (non-negotiable — the screenshot critic depends on it)

The screenshot harness calls `window.__NONA__.step(frames, dt)`. During a step
the engine advances every module with a **fixed dt** and renders. Therefore:

- No `Math.random()` anywhere. Use `engine.rand(seed)`.
- No `Date.now()` / `performance.now()` in sim code. Use `engine.clock.elapsed`.
- Same scenario + same frame count ⇒ pixel-identical output.

## Cross-module events (the bus)

Emit these; don't reach into other modules.

```
'damage'        {target, amount, type, crit, hitPoint, hitNormal, sourceId}
'death'         {entity, killer, hitPoint}
'ability:cast'  {id, caster, origin, dir, level}
'impact'        {point, normal, kind, magnitude}   // vfx + decals + audio listen
'loot:drop'     {item, position}
'loot:pickup'   {item}
'level:up'      {level, stats}
'ui:toast'      {text, tier}
'camera:shake'  {amp, freq, duration}
'weather:set'   {kind, intensity}
'scenario'      {name}
```

## AssetForge (`engine.assets`)

Procedural asset factory. Extend it in your module only via
`engine.assets.register('name', fn)`; the core factory file is owned by the
Rendering agent.

```js
engine.assets.pbr({ kind:'stone'|'wood'|'metal'|'cloth'|'flesh'|'dirt'|'gold',
                    size:1024, seed:7, tiling:4 })
  -> { map, normalMap, roughnessMap, metalnessMap, aoMap, displacementMap }
```

All maps are `THREE.DataTexture` or offscreen-canvas derived, mipmapped,
anisotropy = renderer max, `colorSpace` set correctly (`SRGBColorSpace` for
albedo/emissive only; everything else `NoColorSpace`).

## Rendering standards (this is what "AAA" means here — the critic checks these)

- **Linear workflow.** `renderer.outputColorSpace = SRGBColorSpace`,
  ACES-Filmic tonemap, `toneMappingExposure` tuned per-scenario.
- **No flat ambient.** Ambient comes from an IBL environment probe + hemisphere
  term, never a raw `AmbientLight` fill.
- **Shadows:** cascaded shadow maps (3–4 cascades), PCSS-style soft penumbra,
  normal-offset + slope-scaled bias. No peter-panning, no acne, no visible
  cascade seams.
- **Post chain order:** SSAO/GTAO → SSR → transparent/forward → bloom (physical,
  threshold ~1.0, 5+ mip chain) → volumetrics/godrays → DOF → motion blur →
  ACES tonemap → color grade LUT → film grain → chromatic aberration (subtle)
  → vignette → TAA/FXAA resolve.
- **Never let the frame look "video-gamey flat."** Value range must span true
  black to specular white. Contrast, colored bounce light, atmospheric depth.
- **Material fidelity:** every surface needs normal + roughness variation.
  Uniform roughness reads as plastic and is an instant critic fail.

## Performance budget (1920x1080, Apple Silicon, `ultra` tier)

| Metric | Budget |
|---|---|
| Frame time | ≤ 16.6 ms |
| Draw calls | ≤ 900 |
| Triangles | ≤ 3.5 M |
| Programs | ≤ 90 |
| GPU textures | ≤ 320 MB |

Instance everything repeated. Merge static geometry. Frustum + distance cull.
Expose your module's cost via `engine.profiler.mark('yourModule')`.

## Shipped addons you SHOULD use (three r185, already in node_modules)

`three/addons/*` maps to `three/examples/jsm/*`. These are part of the three
package — using them is not a new dependency. **Use them instead of hand-rolling.**

```js
import { EffectComposer }   from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass }       from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass }         from 'three/addons/postprocessing/GTAOPass.js';   // ground-truth AO — use this, not SSAOPass
import { SSRPass }          from 'three/addons/postprocessing/SSRPass.js';
import { UnrealBloomPass }  from 'three/addons/postprocessing/UnrealBloomPass.js';
import { TAARenderPass }    from 'three/addons/postprocessing/TAARenderPass.js';
import { SMAAPass }         from 'three/addons/postprocessing/SMAAPass.js';
import { BokehPass }        from 'three/addons/postprocessing/BokehPass.js';
import { LUTPass }          from 'three/addons/postprocessing/LUTPass.js';
import { OutputPass }       from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass }       from 'three/addons/postprocessing/ShaderPass.js';
import { CSM }              from 'three/addons/csm/CSM.js';                    // cascaded shadows
import { Sky }              from 'three/addons/objects/Sky.js';                // Preetham/Hosek atmosphere
import { Water }            from 'three/addons/objects/Water.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { DecalGeometry }    from 'three/addons/geometries/DecalGeometry.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Octree }           from 'three/addons/math/Octree.js';                // broadphase
import { Capsule }          from 'three/addons/math/Capsule.js';               // character collider
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';  // scatter on surfaces
import { ImprovedNoise }    from 'three/addons/math/ImprovedNoise.js';
import { SimplexNoise }     from 'three/addons/math/SimplexNoise.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
```

Also available: `three/addons/utils/SkeletonUtils.js`, `.../loaders/*` (unused —
no external assets), `.../modifiers/*`, `.../curves/*`, `.../environments/RoomEnvironment.js`
(useful as an IBL source with `PMREMGenerator`).

**Custom shaders are still expected** where addons fall short — height-blended
terrain splatting, hair/cloth, dissolve, volumetric light shafts, GPU particles.
Extend stock materials with `onBeforeCompile` rather than rewriting them.

## Screenshot harness

```bash
node tools/shot.mjs --scenario=combat --out=shots/combat.png --w=1920 --h=1080
node tools/shot.mjs --all
```

Scenarios: `hub dungeon combat boss overworld inventory closeup night`.
`src/game/Scenarios.js` (integrator-owned) sets up each one deterministically.

## Art direction bible (deviating from this is a critic fail)

- **Palette:** desaturated cold base (slate, ash, wet stone, iron) punctuated by
  warm firelight and a single saturated accent per scene (hellfire orange,
  necrotic green, arcane violet). Never rainbow.
- **Value structure:** dark. Mid-tones dominate, highlights are rare and earned.
  The player silhouette must always read against the ground.
- **Grounding:** contact shadows/AO under every object. Nothing floats.
- **Wear:** edge wear on metal, moss/damp in crevices, dust accumulation on
  up-facing surfaces, grime in cavities. Clean geometry is a critic fail.
- **Camera:** ~55° pitch, 40–55° FOV, subtle handheld noise, spring-damped
  follow with lookahead. Never a rigid locked camera.
- **UI:** ornate gothic metal frames, parchment/vellum, gem inlays, embossed
  bevels, restrained gold leaf. Rarity colors: white/blue/yellow/orange/red.
  Never flat Material-Design rectangles. Never default browser fonts.
