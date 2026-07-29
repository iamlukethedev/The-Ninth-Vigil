# SANCTUM — Known Visual Defects (live document)

---

# 🔴 ROUND-4 DEFECTS — observed in a 3x zoom of shots/combat.png

Use `node tools/crop.mjs --in=shots/combat.png --x=0.5 --y=0.5 --w=0.3 --scale=3` to reproduce.
**Judging a 1600x900 frame whole hides exactly these flaws. Always zoom before scoring.**

1. **Loot labels dominate the frame and occlude the fight.** Five labels
   ("ANOINTED PLATE CUIRASS OF THE ASHEN CHOIR", "PALE WAR MACE OF THE HOAR GALLOW",
   "IRON GAUNTLETS OF THE LEECH", "EMBER GLASS X2", "184 GOLD") cover the hero and most of
   the combat. The type is several times too large for the frame and the labels overlap each
   other and clip their own plate edges. In Diablo 4 ground labels are small, tight, and
   fade/collapse when they would collide. Fix: cut font size hard, add collision-aware
   stacking with a max visible count, fade by distance, and only show the nearest few
   unless Alt is held. **Owner: src/ui/HUD.js, src/game/Loot.js**

2. **The melee impact VFX is a blown-out white clipped blob** that completely hides the hero
   at the moment of the swing. The player character must never be occluded by its own attack.
   Fix: drop the core intensity below the clip point, shrink the sprite, make it directional
   along the swing arc rather than a radial burst, and shorten its life.
   **Owner: src/vfx/VFXSystem.js**

3. **Enemies read as flat near-black paper cutouts.** The cultist, ghoul, and skeleton have
   no material detail, no rim separation, and no value variation — pure silhouettes. They need
   a cold rim/back light and enough albedo to show cloth/bone/flesh material.
   **Owner: src/chars/Bestiary.js, src/chars/monsters/MonsterMaterials.js, src/render/Lighting.js**

4. **The ritual rune circle reads as a UI overlay, not a ground decal.** It is a thin bright
   white line drawing floating flat above the floor, with no perspective integration, no
   surface conformance, and no material response. Fix: project it onto the floor properly,
   tint it, give the lines width falloff and a subtle emissive that does not bloom, and let
   the floor texture show through. **Owner: src/vfx/Decals.js**

5. **Debris/rubble blocks read as untextured placeholder slabs.** The dark slate-blue blocks
   (bottom-left, and scattered throughout) are flat, near-uniform in value, and materially
   disconnected from the warm stone floor they sit on. They look like prototype boxes.
   Fix: same stone material family as the architecture, with edge bevels, chipping, and
   grime coupling. **Owner: src/world/Props.js, src/world/props/Ruin.js**

6. **Floor reads as loose grey gravel rather than laid crypt flagstones.** High-frequency,
   busy, and cold-grey where the architecture is warm tan — the two do not read as the same
   building. Fix: larger, flatter laid stones with visible joints in the walkable areas,
   reserving loose rubble for edges and damaged patches.
   **Owner: src/world/TerrainMaterial.js, src/world/Terrain.js**

7. **Column capitals are detached floating slabs.** In the live dungeon view the dark blue-grey
   capital blocks sit visibly separated from their warm tan shafts, at inconsistent angles, and
   several columns terminate in mid-air supporting nothing. Both the geometry seam and the
   material mismatch are instant "unfinished" tells. **Owner: src/world/Dungeon.js,
   src/world/dungeon/Pieces.js**

8. ~~Loading veil persisting over gameplay~~ — **not a real bug.** Observed only while agents
   were live-editing files, so Vite hot-reloaded the page and restarted boot mid-capture. A
   failsafe removal has been added to src/main.js regardless. If you see the "SANCTUM / ENTER"
   overlay during a capture, your capture raced an HMR reload — re-capture rather than chasing it.


Read this alongside ENGINE_CONTRACT.md and CRITIC_RUBRIC.md. These are defects observed
in actual captured frames. If your module is implicated, **fixing it is part of your task.**

---

# 🔴 CRITICAL — TEXTURE UNIT EXHAUSTION (fix before anything else)

**Symptom:** the entire scene renders as flat untextured white. Geometry, lights,
characters and props are all present and correct, but every PBR surface is blank white.

**Root cause — confirmed from console output:**
```
1452x  THREE.WebGLTextures: Trying to use N texture units while this GPU supports only 16
 256x  WebGL: INVALID_OPERATION: useProgram: program not valid
   4x  THREE.WebGLProgram: Shader Error - VALIDATE_STATUS false
         Material Name: dungeon:stone / dungeon:cap / dungeon:ember / SanctumBlood
         Program Info Log: FRAGMENT shader texture image units count exceeds MAX_TEXTURE_IMAGE_UNITS
```
Materials **fail to compile**, so WebGL falls back and draws them white. This is not a
lighting or grade bug — do not attempt to fix it in post.

**The budget:** a fragment shader gets **16** texture image units, total, shared between
the material's own maps and everything the renderer injects. Current per-material usage:
6 PBR maps (map, normal, roughness, metalness, ao, displacement) + 4 CSM cascade shadow
maps + up to 4 point-light shadow maps + envMap + cloud-shadow + weather depth ≈ 17–19.

**Required fixes (in priority order):**

1. **Pack ORM.** Combine occlusion→R, roughness→G, metalness→B into ONE RGB texture, the
   standard AAA layout. `AssetForge.pbr()` must return an `ormMap` and materials must bind
   it once, using `aoMap = roughnessMap = metalnessMap = ormMap` with the channel routed in
   the shader. **Saves 2 units per material.**
2. **Drop `displacementMap` entirely** from runtime materials. It costs a vertex+fragment
   unit and contributes almost nothing at this camera distance; the normal map carries the
   detail. **Saves 1 unit.**
3. **Zero CSM cascades for interiors.** `crypt`/`hell`/`arena` have no sun — a sunless
   scenario must allocate 0 directional cascades, not 4. **Saves up to 4 units indoors.**
4. **Cap shadow-casting point lights at 2** (was 4). Importance-select as already designed.
   **Saves 2 units.**
5. After fixing, assert it: log
   `renderer.capabilities.maxTextures` against the worst-case per-material count at init and
   warn loudly if the margin is under 2. A silent regression here white-screens the game.

**AssetForge is also out of memory:** `[assets] texture budget reached — new maps degrade to
Npx`. ORM packing reduces map count by a third, which helps; also drop the resolution of
maps used only on distant/small props.

---

# 🔴 CRITICAL — GEOMETRY BUDGET BLOWN 7–14×

Measured on the live `dungeon` scenario:

| Metric | Measured | Budget | Over by |
|---|---|---|---|
| Draw calls | **6,122** | 900 | 6.8× |
| Triangles | **48,496,581** | 3.5 M | 13.9× |
| Programs | **124** | 90 | 1.4× |

It currently still hits ~119 fps on an M-series GPU, so this reads as "fine" if you only
watch the framerate — it is not fine, it will collapse on any weaker GPU and it starves the
frame of headroom for VFX, physics and UI which are not built yet.

**Required:** instance aggressively (one `InstancedMesh` per geometry+material pair),
merge static geometry per room/chunk, cut tessellation on props that are never seen close,
add real distance LOD and frustum culling, and share materials so the program count falls.
Dungeon and Props are the primary offenders — audit both.

---

## WORLD SCALE — canonical, and currently violated

**1 world unit = 1 metre.** Everything must be authored to this. Reference sizes:

| Thing | Size (metres) |
|---|---|
| Hero height | 1.85 |
| Hero shoulder width | 0.62 |
| Cobblestone / floor setts | 0.18 – 0.32 across |
| Ashlar wall block | 0.55 w × 0.32 h |
| Floor slab (crypt) | 0.9 – 1.4 |
| Doorway height | 2.4 |
| Room ceiling | 5 – 7 |
| Barrel | 0.55 dia × 0.85 h |
| Tombstone | 0.6 w × 1.1 h |
| Brute enemy height | 3.2 |
| Boss height | 6 – 7 |
| Camera distance from hero | 26 – 34 |

**DEFECT — texture tiling scale is far too coarse.** In captured frames the floor setts
read as roughly **1.5–2 m across**. That single error makes every frame look like a macro
photograph of a cobbled street rather than an isometric view of a world, and it is the
reason the camera *appears* to be 3 m off the ground when it is actually at 28 m.
Terrain/TerrainMaterial must set `tiling` so a sett is ~0.25 m. Same for every wall,
floor, and prop material.

---

## Confirmed defects by module

### Terrain / TerrainMaterial
- **Tiling scale wrong** (above). Highest-priority visual bug in the project.
- Near-field detail tile fades out too early, so mid-distance ground goes soft and mushy.
- Wetness/puddle mask is applied broadly enough that entire regions read as polished
  glass. Puddles should be *localised* to depressions, with a visible dry/wet boundary.

### RenderPipeline
- **DOF is drastically too strong.** In `hub` and `inventory` the entire frame is a
  shallow-focus blur with 40+ px bokeh circles. This is an ARPG at 28 m, not a macro lens.
  DOF must be nearly imperceptible for gameplay scenarios (`hub`, `overworld`, `combat`,
  `dungeon`, `night`, `boss`) — a slight far-field softening only. Reserve real DOF for
  `closeup` and background-only blur behind `inventory` panels.
- Bloom on the small torch sources is producing large soft discs that read as lens bokeh
  rather than light. Tighten the radius, lower the strength, raise the threshold.
- `overworld` resolves to a near-flat grey wash: no true blacks, sd 0.095, 39 distinct
  colours. Needs contrast recovery in the grade plus content in frame.

### Lighting
- **Torch lights have no fixture and no flame.** They render as bare floating glowing
  orbs — reads as fireflies or lens dirt, an instant-fail "billboard blob". Every practical
  light MUST be co-located with actual geometry: a wall sconce, a brazier bowl with coals,
  a candle, a hanging lantern, or a campfire with logs — plus a flame. Props/Dungeon own
  the fixtures; Lighting must place lights *at fixtures*, not in empty air.
  Coordinate through the bus: fixtures announce themselves, lights attach.
- Practicals are distributed evenly across open ground. Light placement is composition:
  motivate every source with an object and a reason.

### Sky
- Exterior fog was recalibrated to stop washing frames out, but `overworld` still reads as
  featureless. Aerial perspective needs to reveal *layers*, which requires distant content
  (silhouette ring, hills, ruins) to actually be present.

### General
- **No scale reference exists in any frame yet** because there is no character. Once Hero
  lands, re-check every material's tiling against the 1.85 m hero.
- Frames contain no props, architecture, characters, or VFX — every current frame is
  terrain + lights + sky. Craft density scores near zero until that changes.

---

## Standing requirements that keep getting missed

1. **Every light needs a visible source object.** No exceptions.
2. **Every object needs contact occlusion** where it meets the ground.
3. **Bevel every hard edge.** Sharp 90° corners catch no highlight and read as prototype.
4. **Nothing may be placed on a visible grid or at uniform spacing.** Cluster and vary.
5. **Emissive intensity > 1.0 only for things that should bloom** (flame, lava, runes,
   magic). Nothing else may exceed 1.0, or bloom becomes a full-frame haze.
6. **Guard every cross-module call** — `engine.get('x')?.fn?.()`. Modules can be absent.
