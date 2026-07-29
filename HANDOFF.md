# SANCTUM — Continuation Prompt (paste this into Cursor)

Everything below the line is a self-contained brief. It assumes zero prior conversation.

---

You are continuing work on **SANCTUM**, a Diablo 4–class isometric action RPG built in
Three.js r185. It is a real, working, feature-complete game: ~98,700 lines across 142 files,
21 engine modules, running at 60+ fps.

**Project root:** `/Users/lucasguilherme/Apps/World Of Warcraft`
(the folder is named "World Of Warcraft" for historical reasons — the game is SANCTUM)

## Step 0 — read these three files before touching anything

1. `ENGINE_CONTRACT.md` — the binding integration contract: module lifecycle, engine
   services, the event bus, determinism rules, performance budget, art-direction bible,
   and which bundled `three/addons/*` to use instead of hand-rolling.
2. `CRITIC_RUBRIC.md` — the 10 scored axes, the 15 instant-fail flags, and the required
   verdict output format. This is how the work is judged.
3. `KNOWN_ISSUES.md` — every confirmed defect with pixel coordinates, plus the
   **canonical world scale table (1 unit = 1 metre)**. Getting scale wrong has been the
   single most repeated failure on this project.

Then skim `src/core/Engine.js` (services + lifecycle), `src/core/Rand.js` (the deterministic
PRNG/noise kit you must use), `src/game/modules.js` (the module manifest and load order),
and `src/game/Scenarios.js` (the 8 scenarios everything is judged against).

## How to run it

```bash
npm run dev          # http://localhost:5190  (add ?shot=combat, ?shot=boss, &q=med)
npm run check        # capture all 8 scenarios + objective frame analysis
```

Controls: click-to-move + WASD, LMB/RMB and 1–4 for abilities, Space to dash.
Audio needs one click on the page (browser autoplay policy).

## The tooling — use it, it is the whole quality loop

| tool | purpose |
|---|---|
| `node tools/shot.mjs --all --w=1600 --h=900` | deterministic headless capture of all 8 scenarios to `shots/` |
| `node tools/shot.mjs --scenario=combat --out=shots/_debug/x.png` | one scenario |
| `node tools/sheet.mjs --analyze` | contact sheet + **objective** frame metrics (lifted blacks, missing highlights, contrast collapse, oversaturation) |
| `node tools/crop.mjs --in=shots/combat.png --x=0.5 --y=0.5 --w=0.25 --scale=4` | crop + nearest-neighbour zoom. **Essential** — a 1600x900 frame viewed whole hides the defects that matter |
| `node tools/actors.mjs --port=5190` | actor visibility audit: is a character not drawing, off-frame, too small, or drawing with no value separation from the floor |
| `node tools/live.mjs --port=5190` | capture the live browser path (catches bugs that only exist outside the harness) |
| `node tools/debug.mjs --scenario=combat` | boot with full console/error output |
| `node tools/probe.mjs --port=5190` | live scene-graph inspection |

`shots/` holds the 8 canonical frames. **Put all scratch captures in `shots/_debug/`** or you
will pollute the contact sheet.

## ⚠ THE VERIFICATION TRAP — read this before you trust any screenshot

**`tools/shot.mjs --scenario=X` and the live game are two structurally different worlds, and
the harness cannot see an entire class of bug.**

`shot.mjs` loads `?shot=X`. `Terrain.init()` reads that query param and boots straight into the
correct biome. The live game — `npm run dev`, open localhost, i.e. **exactly what the player
does** — has no param, so Terrain boots to `'moor'` and only rebuilds to the right biome later,
when `main.js` applies the scenario. Any bug that depends on that boot ordering is **invisible
to every screenshot the harness takes.**

This actually happened and cost a lot of time: the player reported "I can't see my hero or any
enemies" while every canonical capture showed them rendering correctly. The real cause was that
the crypt geometry stayed baked on the moor heightfield while actors were placed on the new one,
so every character stood ~3.5 m *below the drawn floor* and was occluded by it. `bodyLuma 0.004`
was measuring floor pixels, and two rounds of "fix the black materials" chased a defect that did
not exist. See "Recently fixed" for the patch.

**Therefore: for anything the player can see, verify on the LIVE path.**

    (lsof -ti:5190 >/dev/null 2>&1 || (node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5190 --strictPort >/tmp/v.log 2>&1 &)); sleep 7
    node tools/actors.mjs --port=5190     # no --scenario → the live default boot
    node tools/live.mjs   --port=5190

Two more gotchas with the live path:
- **Restart the dev server for a clean read.** The first one or two `actors.mjs` runs against a
  cold Vite catch the page mid-compile and report the hero at `(0,0,0)` with 0 meshes. That is
  a measurement artifact, not a bug. Run it three times and use the warm runs.
- **Enemies churn.** The hero auto-fights, so entities die and the Director respawns them.
  `bestiary.entities` legitimately reads 0 at some instants. Never conclude "the collection is
  broken" from a single empty read — `actors.mjs` is the ground truth.

### The actor-visibility oracle

`tools/actors.mjs` turns "is the character visible?" into a number. Thresholds that count as
passing:

| metric | target | meaning |
|---|---|---|
| `visibleMeshes` | > 0 | 0 means not drawing at all |
| `inFrame` | true | false means it spawned off-camera |
| `hPx` | > 40 | smaller than that cannot be read at gameplay distance |
| `SEP` | >= 0.15 | luma separation from the floor behind it; under 0.05 is invisible to a human |
| `occluderY` | none | geometry between camera and torso — the bug described above |

Run it three times and require every run to pass.

## Non-negotiable constraints

- **No new npm packages.** three + bundled `three/addons/*`, vite, playwright. That is all.
- **No external assets, ever.** No image files, no fonts, no models, no CDN, no runtime
  fetches. Every texture, mesh, animation and sound is generated procedurally. This is the
  defining constraint of the project — do not "fix" a problem by downloading an asset.
- **16 fragment samplers is a hard GPU limit and the project sits near it.** Exceeding it
  makes shaders fail to **link**, and WebGL then draws those materials **flat white** — the
  entire scene turns white. This has happened twice. If you add material maps, check for
  `texture image units count exceeds` and `program not valid` in the console.
- **Determinism is mandatory.** No `Math.random()`, no `Date.now()`/`performance.now()` in
  simulation code — use `engine.rand(seed)` and `engine.clock.elapsed`. Two captures of the
  same scenario must be byte-identical (`md5` them). The visual review depends on this: if
  frames drift, you cannot attribute a change to a fix.
- **Never edit** `src/main.js`, `src/core/Engine.js`, `src/game/modules.js`,
  `src/game/Scenarios.js`, `index.html`, or `tools/*` without a deliberate reason — they are
  the integration spine every module is written against.
- **Performance budget:** 16.6 ms/frame at 1080p. Current: dungeon 4.9, boss 4.7, combat 6.5,
  closeup 6.5, night 8.8, overworld 8.9, hub 11.4. Draw calls and triangles are still **over**
  budget (~1300–1700 calls vs 900; 8–12 M tris vs 3.5 M) — mostly shadow passes, but worth
  reducing.

## Two process rules that were learned the hard way

**1. Serialize by file ownership.** When six fixers ran in parallel, two both owned
`Decals.js` and two both owned `Lighting.js`. Whoever wrote last won, and a reviewer then
correctly found **seven of thirteen** defects still present at the same pixel coordinates. If
you parallelize, partition files strictly and run conflicting groups in sequence.

**2. Prove every fix in pixels, not in code.** The dominant failure mode on this project is
changing code, reasoning that it should work, and reporting success while the defect is
untouched. For every fix: capture the affected scenario, `crop.mjs`-zoom the exact region,
**look at it**, make the change, re-capture the identical crop, look again. If the defect is
still visible, you are not done. State measured values (luma, pixel size) in your report.

## Current state — what works

All 21 modules load: `assets sky lighting terrain water dungeon props town weather hero
bestiary ai combat physics loot director camera vfx decals audio hud render`.

- **Procedural PBR material forge** — 13 material families (stone, cobble, wood, metal, gold,
  cloth, leather, flesh, bone, dirt, moss, ash, blood) with coupled wear/grime (darker +
  rougher + occluded together), Sobel-derived normals, ORM packing, PMREM environment.
- **Rendering** — GTAO, SSR, physical bloom, volumetric shafts, DOF, motion blur, ACES,
  a 3D-LUT grade with per-scenario looks, film grain, CA, vignette, TAA/SMAA, auto-exposure.
- **Lighting** — 4-cascade CSM, importance-selected shadow-casting practicals, layered
  deterministic flame flicker, IBL + hemisphere ambient, light probes.
- **World** — eroded chunked-LOD terrain with height-blended 4-layer splatting and triplanar
  slopes; procedural gothic crypt architecture (coursed ashlar, ribbed vaults, pointed arches
  with voussoirs, fluted columns) with an age/damage pass; instanced props (vegetation, rock,
  ruin, human, macabre) with light fixtures; water/blood/lava; rain/snow/ember/dust/fog-banks;
  a town with buildings, walls, stalls and NPCs.
- **Actors** — procedurally rigged and skinned hero (93 k tris: helm, layered plate, tabard,
  verlet cloak, sword) with foot-planting IK; 6 enemy archetypes + a boss, ragdolls.
- **Gameplay** — 10 abilities, hit-stop, knockback, stagger, damage types/resistances/crits,
  A* nav with local avoidance and attack-token pack coordination, boss phases, full
  itemization with procedurally-named legendaries, encounter director, procedural audio
  (synthesised SFX + adaptive modal score).
- **UI** — ornate gothic HUD: liquid health/fury orbs, rune ability bar with cooldown sweeps,
  XP bar, framed minimap, quest log, boss phase bar, floating damage numbers, rarity-coloured
  loot labels, paper-doll character sheet, skill tree, item tooltips.

## Current state — the honest assessment

A hostile art-director review scored it **3.5/10, NOT_AAA** over two rounds (3.2 → 3.5). Every
per-scenario blind A/B against a comparable Diablo 4 capture said D4, most recently "not
close." Frames pass the objective analyser but the images are the real judge.

**The remaining gap splits into two kinds, and only one is fixable by iteration:**

*Fixable engineering* — clipped additive sprites, missing contact occlusion in lit areas,
telegraphs compositing above the scene, a grain-chroma value speckling every edge, black
enemy silhouettes, an unfinished boss arena. Real bugs. Worth doing.

*Art production* — the reviewer's own words: "D4 never lets you see a repeat or a straight
continuous joint; its floors break, sag, lift, and pool water in depressions." That is
hundreds of artists hand-placing individual assets over years, not a shader problem. Any
generator produces *some* detectable regularity, and a reviewer told to find flaws will find
it. Same for D4's ~200 hand-sculpted armour sets vs one procedural rig.

**Recommended definition of done: drive the instant-fail count to zero.** That is the line
between "looks broken" and "looks like a genuinely good atmospheric ARPG running in a
browser." Chasing 8+ on every rubric axis past that point spends enormous effort
re-litigating procedural-vs-authored. Do not report that this beats Diablo 4 — it does not,
and a false pass ends the work prematurely.

## The prioritised work queue

Severity is from the last review. Items marked **RE-RAISED** were previously reported fixed
and were not — verify these in pixels with extra suspicion.

1. **[sev 9 — NEW, never yet investigated] Large hard-edged black wedges cut across the frame.**
   Visible in a 2x zoom of the live dungeon boot: several big, straight-sided, hard-edged black
   polygons crossing the play area, unrelated to any light source. They were previously hidden
   because the floor bug (see "Recently fixed") was occluding everything anyway, so this has
   never been looked at. A hard-edged un-feathered black shape reads to a player as a rendering
   failure, which makes it the most damaging thing in frame right now.
   *Suspects, in order:* a broken shadow volume or a cascade boundary; the CameraRig occluder-fade
   system mis-selecting geometry and driving it to black instead of fading it; a decal or fog
   card with a bad transform. Diagnose before fixing — do not just fade them out.
   *Verify on the LIVE path* (`node tools/actors.mjs --port=5190`, then zoom
   `shots/_debug/actors.png`), because the harness may not reproduce it.
   *Owner:* start with `src/render/Lighting.js`, `src/game/CameraRig.js` (occluder fade),
   `src/render/passes/VolumetricPass.js`, `src/vfx/Decals.js`

2. **[sev 7 — residual, partially fixed] Character luma separation still short on some actors.**
   After the floor-occlusion fix, most actors read well (hero SEP 0.363, hellhound 0.464,
   skeleton 0.377, cultist 0.435) but **3 of 8 remain under the 0.15 target** (measured 0.067,
   0.054, 0.038) — bodies landing on floor of a similar value.
   Do NOT re-do the albedo floor or the rim injection: both are already correctly implemented
   and verified present in the compiled fragment shaders (`userData.charRim` is set at
   `MonsterMaterials.make()` ~line 346, `uMonAlbFloor` and `#define SANCTUM_HERORIM` are live in
   every monster material). This is a *tuning* job on `Lighting.js` `_heroRim` — `gain` (0.62)
   and `pool` — plus possibly a value-aware term so a body on similar-valued floor gets more rim.
   Worth ~0.05–0.10 SEP. Verify with the oracle; require all three runs to pass.
   *Owner:* `src/render/Lighting.js`, `src/render/LightRig.js`

3. **[sev 10, RE-RAISED] Additive VFX clip to pure white with sawtooth rims.** In `boss`,
   fourteen identical white loot-glow discs are each brighter and larger than the boss. The
   melee impact is a white blob that hides the hero.
   *Fix:* hard-cap every additive sprite so peak radiance lands ~0.85 in **tonemapped**
   output — let bloom create the brightness read, not clipping. Smooth radial alpha with zero
   slope at the rim (the sawtooth is a low-segment disc). Loot glows small and rarity-tinted,
   not white discs.
   *Owner:* `src/vfx/VFXSystem.js`, `src/vfx/emitters/*`, `src/game/Loot.js`

4. **[sev 10, RE-RAISED] Telegraphs are screen-space line art, not decals.** Proof: the boss
   rune circle draws **over** the hero's ground shadow, so it is composited above the scene.
   *Fix:* render as depth-aware projected decals — sample scene depth, reconstruct world
   position, reject fragments beyond a threshold from the decal plane, so geometry occludes
   them and they conform to floor slope. Real stroke width falloff, tinted, low-alpha interior
   so floor texture reads through, rim-emphasised, emissive below the bloom threshold. They
   must stay crisply legible — they are gameplay-critical.
   *Owner:* `src/vfx/decals/Telegraph.js`, `src/vfx/decals/Surface.js`, `src/vfx/Decals.js`

5. **[sev 9, RE-RAISED] No contact occlusion where light is bright.** Under the hero's boot
   the floor value is unchanged; rubble cuts the floor at a razor line with full brightness
   beneath it.
   *Fix:* SSAO alone cannot do this — make the AO term multiply **direct** lighting, not just
   ambient (a bright point light currently overwrites it), and add an explicit contact-shadow
   layer under every character and prop. Verify the floor luma directly under the sole is
   measurably darker than 30 px away; report both numbers.
   *Owner:* `src/render/passes/AOApplyPass.js`, `src/render/passes/GBuffer.js`,
   `src/vfx/Decals.js`, `src/world/props/Scatter.js`

6. **[sev 8] Terrain is a dead-flat plane with a repeating regular tile grid.** Continuous
   dead-straight joints run the full frame; the identical pebble cluster appears in three
   places.
   *Fix:* halve FLAG/COBBLE tile values again and **measure, do not reason** — render a
   1.85 m reference box and require 6–8 setts across its width; lock the number in a comment.
   Jitter per-slab offset/rotation so no joint runs continuously. Add real height variation
   (sagged/lifted slabs, subsidence) with puddles pooling in the depressions, and low-frequency
   macro variation so the repeat stops reading.
   *Owner:* `src/world/TerrainMaterial.js`, `src/world/Terrain.js`, `src/world/town/Street.js`

7. **[sev 8, RE-RAISED] One noise at one scale is doing every material.** The same dimpled
   pattern appears on the hero's helm, gorget, cuirass, arms and skirt — and on terrain and
   rubble.
   *Fix:* three frequency tiers in every surface kind, minimum two per material: mid-frequency
   **structure** that differs per family (hammer planishing ~45 mm for plate, ring topology
   ~6 mm for mail, weave ~2 mm for cloth, pore ~0.5 mm for leather, coursing for stone), then
   wear that follows form (edge wear to bright metal on borders/ridges, cavity tarnish, scuffing
   where straps rub), then fine grain.
   *Owner:* `src/core/texgen/Kinds.js`, `src/core/texgen/Field.js`, `src/chars/CharacterMesh.js`

8. **[sev 8, RE-RAISED] Exteriors have no sky and no aerial perspective.** In `overworld` the
   sky is a flat grey card (#b9bbbd) **brighter than the world**, so the brightest thing in
   frame is a featureless rectangle; a hard cloud-layer seam crosses the top; distant ridges
   have identical value/saturation to near terrain so hills read as holes. You can see the raw
   edge of the heightfield against grey void.
   *Fix:* real graded sky with sun position and colour-temperature gradient. Exponential height
   fog as a function of view depth keyed to the sky's horizon colour — **verify by measuring**
   value and saturation at 20 m, 80 m, 300 m; value must rise monotonically toward the horizon
   and saturation must fall. Add a fogged distant landmass silhouette band.
   *Owner:* `src/render/Sky.js`, `src/render/Atmosphere.js`, `src/render/passes/VolumetricPass.js`

9. **[sev 7, RE-RAISED] Chroma grain speckles every high-contrast edge.** Cyan/magenta single
   pixels along every mortar joint in all 8 scenarios. Root cause: `grainChroma: 0.28` in
   `src/render/RenderPipeline.js`.
   *Fix:* drop to ~0.04 and gate the chroma term on local **contrast** (3x3 luma gradient
   magnitude), not just luma — the existing luma knee cannot help on a mid-tone joint edge,
   which is exactly where the artifact lives. Keep filmic luma grain.
   *Owner:* `src/render/passes/GrainPass.js`, `src/render/RenderPipeline.js`,
   `src/render/passes/CAVignettePass.js`

10. **[sev 7] An over-intense practical clips whole architectural elements to solid white.**
   What looks like a "flame" in `combat` is proven at 8x to be a 4 m **column** driven to pure
   #FFF over its whole height by the brazier at its base — brick coursing still visible through
   the clipping.
   *Fix:* cap practical intensity so no surface within 1 m of a fixture exceeds ~0.90 tonemapped;
   use physical inverse-square falloff. Add a max-luminance probe that fails if >0.4% of pixels
   exceed 0.98.
   *Owner:* `src/render/Lighting.js`, `src/world/props/Fixtures.js`,
   `src/render/passes/ExposurePass.js`

11. **[sev 6] The boss arena is the least-finished environment** and it has to sell spectacle
    (lowest-scoring scenario, 2.5/10). Untextured floor gradient, flat black wall trapezoids,
    and the boss health bar is a plain red fill with a thin white border while the player's own
    orbs are fully sculpted — inconsistent within one HUD.
    *Fix:* give the arena the crypt's full material stack (laid slabs, ritual apron, scorch,
    bone scatter, chains, braziers, authored clustering); texture and light the walls; rebuild
    the boss bar to the HUD's own ornament quality.
    *Owner:* `src/world/dungeon/Arena.js`, `src/ui/panels/Combat.js`, `src/game/CameraRig.js`

12. **[sev 6] UI craft collapses outside the two health orbs.** The inventory grid has not one
    specular highlight; slot frames are a single flat value with no inset bevel; panel interiors
    are flat gradients with no leather/parchment material. Whole frame measures p99 0.563.
    *Fix:* procedurally generate hammered metal with directional specular, worn parchment with
    fibre, leather grain, gem cabochons with highlights. Inset bevel on every socket (light
    above, dark below). Get UI p99 above 0.8.
    **Note:** a reviewer asked for a self-hosted woff2 gothic font — **do not add one**, it
    violates the no-external-assets rule. Achieve the display feel with letterspacing, weight,
    scale hierarchy, and procedurally drawn ornamental capitals.
    *Owner:* `src/ui/UITheme.js`, `src/ui/UIAtlas.js`, `src/ui/panels/*`

13. **[sev 5] Prop scatter reads as one asset stamped repeatedly**, sometimes in visible lines.
    The same blue-grey chamfered slab appears ~30 times in `combat` including a clean diagonal
    run. Also: those slabs read as untextured placeholder boxes, materially disconnected from
    the warm stone floor they sit on.
    *Owner:* `src/world/props/Scatter.js`, `src/world/Props.js`, `src/world/props/Ruin.js`

14. **[sev 5] Draw calls / triangles over budget** (~1300–1700 calls vs 900, 8–12 M tris vs
    3.5 M) and a **~97 ms p99 hitch** on scenario load from shader program linking. Frame time
    itself is fine. Instance harder, merge static geometry per room, share materials to cut the
    program count, and pre-warm shader compilation.
    *Owner:* `src/world/Dungeon.js`, `src/world/Props.js`, `src/core/AssetForge.js`

## Recently fixed — do not regress these

- **🔴 THE FLOOR BUG — the most important fix in the project's history, and the one most likely
  to be accidentally reverted.** On the live default boot, actors rendered ~3.5 m *beneath the
  drawn dungeon floor* and were occluded by it, so the player saw an empty room.
  Chain of causation: `Terrain.init()` (`src/world/Terrain.js:301-310`) picks its biome from the
  `?shot=` param, so with no param it stays on `'moor'` (hills, ground y≈4). `Dungeon.init()`
  (`:208`) then bakes the crypt flagging onto that moor field. `main.js` applies the `dungeon`
  scenario, Terrain rebuilds flat to the crypt field (y≈0) — but `Dungeon.applyScenario` passes
  the SAME `('crypt','crypt')`, so the `_setMode` memo early-returned and **the geometry was
  never re-laid**. `floorHeightAt()` is a live closure over `terrain.heightAt`, so actors tracked
  the new floor while the geometry stayed frozen on the old one. Measured drift +3.24…+3.71 m.
  **The fix** is a `groundMoved` guard in `Dungeon._setMode()` — the memo now also compares live
  `this._g(0,0)` against build-time `this.floorY` and rebuilds if they differ by >0.05.
  Physics re-derives automatically via the existing `dungeon:built` bus event.
  *If you ever "simplify" that memo back to `(mode, biome)`, every character vanishes again.*
  Also note: this is the bug that proves the Verification Trap section above — it was invisible
  to all eight canonical screenshots, and two full rounds were wasted "fixing black materials"
  that were never broken. `userData.charRim`, `uMonAlbFloor` and `#define SANCTUM_HERORIM` were
  all verified present in the compiled fragment shaders the whole time.
- **Actor visibility.** `hero.root` contained 0 meshes (skinned meshes were parented outside
  it and only rendered because skinned geometry follows bones). Now 8 meshes / 93,298 tris.
  Half the enemies spawned ~15 m off-camera (projecting to screen Y 1416 and 1611 in a 900px
  frame); placement is now frustum-aware via `CameraRig.scenarioFrame()` and
  `Hero.scenarioAnchor()`. Species are scaled to spec. Camera pulled 24 → 14.5 m so the hero
  reads at 8.5% of frame height. Verify with `tools/actors.mjs`.
- **Texture-unit overflow** that white-screened the whole game — ORM packing, no
  `displacementMap`, zero sun cascades in sunless interiors, 2 shadow-casting point lights.
- **The live game never applied a scenario**, so the browser path rendered everything
  unconfigured. `src/main.js` now applies one on boot (`?shot=` overrides).
- **`Weather.js` was completely dead** from a backtick inside a GLSL comment terminating the JS
  template literal. Watch for this class of bug — it silently disables an entire module.
- **`physics/Ragdoll.js` was truncated mid-function**, 500-ing the dev server and disabling all
  physics.

## Suggested working method

Work one queue item at a time, or partition strictly by file ownership if you parallelize.
For each: read the owning files, capture + zoom the named region, look at it, fix the cause
(not the symptom), re-capture the identical crop, confirm the defect is gone, then verify you
have not regressed frame time, determinism, or the sampler budget. Re-run
`node tools/sheet.mjs --analyze` and read the 8 canonical frames before moving on.

Start with item 1 — the hard-edged black wedges. It is the most visible defect to a player right
now, it has never been investigated (the floor bug was masking it), and a hard un-feathered black
polygon in frame reads as a rendering failure rather than as art.

**Before you start, sanity-check the build**, because several waves of parallel agents were
mid-flight when this document was written and some of their work may be partially landed:

```bash
node tools/debug.mjs --scenario=combat --frames=40   # all 21 modules must appear in "modules loaded"
node tools/actors.mjs --port=5190                    # run 3x; see the oracle table above
node tools/shot.mjs --all --w=1600 --h=900 && node tools/sheet.mjs --analyze
```

Two failure modes worth knowing on sight, both of which have happened and both of which
silently disable an entire module rather than throwing something obvious:
- **A backtick inside a GLSL comment** terminates the surrounding JS template literal. The
  module then fails to parse and is skipped with a one-line warning. This killed all of
  `Weather.js` once.
- **A file truncated mid-function** (from an agent interrupted by a usage limit) 500s the Vite
  dev server for that path. This killed all of `physics/` once. If a module is missing from
  "modules loaded", check the console for a 500 and parse the file before assuming a logic bug.

Finally: `KNOWN_ISSUES.md` is the live defect log with pixel coordinates and is more detailed
than this queue. Read it, and append to it as you find things.
