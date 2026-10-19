# KNOWN ISSUES — authoritative open list

Re-triaged against a **fresh 8-scenario capture** taken after the cascade fix
(commit `d2aad35`). Everything here has been reproduced on the current build;
anything from the previous list that no longer reproduces is in
[Closed](#closed-no-longer-reproduces) at the bottom rather than being re-fixed.

Every entry is tagged with the `CRITIC_RUBRIC.md` instant-fail flag it trips.
Entries with no flag are quality items, not instant-fails, and are out of scope
until the flags are at zero.

**Measured baseline** (`node tools/sheet.mjs --analyze`, 1600x900):

| scenario | mean | sd | p01 | p99 | blk% | sat | colors | verdict |
|---|---|---|---|---|---|---|---|---|
| boss | 0.122 | 0.165 | 0 | 0.844 | 25.5 | 0.425 | 425 | in range |
| closeup | 0.247 | 0.215 | 0 | 0.781 | 12.6 | 0.264 | 162 | in range |
| combat | 0.300 | 0.245 | 0 | 0.906 | 7.6 | 0.323 | 570 | in range |
| dungeon | 0.287 | 0.236 | 0 | 0.906 | 8.9 | 0.278 | 347 | in range |
| hub | 0.120 | 0.158 | 0 | 0.781 | 28.7 | 0.332 | 295 | in range |
| inventory | 0.204 | 0.193 | 0 | 0.844 | 10.8 | 0.277 | 305 | in range |
| night | 0.100 | 0.149 | 0 | 0.813 | 34.7 | 0.439 | 392 | in range |
| overworld | 0.152 | 0.171 | 0 | **0.656** | 29.9 | 0.231 | 304 | **no highlights** |

Determinism: `dungeon` captured twice is byte-identical
(`94f3dd269cfab7f22fa4bdca6602e260`). Draw calls 880 against a 900 budget,
4.38 M triangles, `p99` 97-103 ms on the first frame (shader link, one-off),
`avg` 8.6-9.3 ms thereafter — inside the 16.6 ms budget.

---

## 1. Hard-edged black wedges — `boss`, live `dungeon` — RESOLVED (1a-1e)

**Flag: "Black, blank, or single-color frame"** · severity 9 · **closed**

The headline defect, and the reason the hero and enemies were reported as "not
showing". Large, straight-sided, un-feathered black polygons cross the play
area and swallow whatever is behind them.

This turned out to be **five stacked causes**, not one, which is why it kept
coming back after each fix looked convincing on a still frame.

1a, 1d, 1e and 1f are fixed and verified below. 1b and 1c were taken by the Wave 3
lighting and grade lanes; their write-ups here still read as proposals and have
not been re-verified against their original measurements, so treat those two
sections as historical. What *is* verified is the flag itself: it no longer
reproduces anywhere. All eight captures pass `sheet.mjs --analyze` in AAA range,
and a full walking lap of the live crypt has no wedge in any frame, worst frame
4.2 % near-black.

1e is the one to remember: it was only findable on the live path with a static
camera and interleaved A/B, and is invisible in any single capture.

### 1a. Four sun cascades in a sunless interior — FIXED (`d2aad35`)

`crypt`/`hell`/`arena` are `sunless`, but their fictional "skylight" key was
casting four CSM cascades through a real ceiling at ~7.3 m. Confirmed by
toggling `castShadow` on the four `nona.csm.*` lights on a live frame:
solid-black frame area fell from 14.9 % to 11.3 % and the wedges disappeared
outright (`shots/_debug/wedge_off_ALL_CSM.png` versus `wedge_base.png`).

`LightRig` had always declared `shadow: false` intent for these presets;
`Lighting._applySunToLights` simply never read the flag. Wiring it through
`setSun` also took the crypt from 6122 draw calls to **880** and returned four
directional shadow samplers to every lit material.

### 1b. Unlit vertical rock faces read as void — OPEN, lane E + lane A

Reproduces deterministically in `?shot=boss`. Hiding meshes one at a time
inside the `Dungeon` group names the culprits exactly:

| mesh | material | bbox (min → max) | solid-black delta when hidden |
|---|---|---|---|
| `Dungeon` child #11 | `dungeon:rock` `#7d6a5e` | `-1.7, 0.0, -1.1` → `1.7, 6.2, 0.4` | **-1.02 pp** |
| `dungeon:weld` #48 | `dungeon:rock` `#7d6a5e` | `11.1, -0.7, -22.3` → `16.5, 5.9, -19.3` | **-0.62 pp** |

These are **6.2 m tall rock formations**, one of them standing at the arena
centre directly behind the boss. Their camera-facing faces are near-vertical.
With no cascades indoors, `hell`'s hemisphere at `0.40` and `envIntensity` at
`0.30`, no light source reaches those faces at all, so they render at
essentially zero before any post-processing.

**Fix:** give near-vertical interior surfaces a real indirect term — probe
bounce, a bumped hemisphere, or a cheap wrap/ambient floor on `dungeon:rock` —
so a 6 m rock reads as dark stone with visible silhouette and surface, not as a
hole in the frame. Do not solve it by deleting the rocks or by fading them.

### 1c. The grade's toe merges dark geometry into solid void — OPEN, lane C

Independent of 1b and general to every scenario. On the frozen `boss` frame,
disabling **only** the grade pass takes solid-black area from **2.32 % to
0.01 %** while the frame mean barely moves (0.2381 → 0.2406).

The grade is not darkening the frame overall; it is crushing everything already
near black to *absolute* zero, which welds a dark object to its dim
surroundings into one large solid shape with a hard outline. That is what turns
a thin rock sliver (visible in `shots/_debug/bw_pass_off_grade.png`) into a
frame-crossing wedge (`shots/_debug/bw_base.png`).

**Fix:** lift the grade's black point / soften its toe so near-black retains a
few code values. The rubric wants true black *present* in shadows — it does not
want 6-metre objects rendered as void. Verify `p01` stays at 0 for a small
fraction of the frame rather than for whole objects.

### 1d. Occlusion was allowed to delete the light — FIXED

The remaining wedges, and all of the *flashing* reported while walking, were
ambient occlusion rather than any shadow. Proved by ablation on a frozen live
frame with seven enemies inside 4 m: setting `shadow.intensity = 0` on every
shadow-casting light left the wedges untouched, while disabling `aoApply` alone
removed them and took near-black area from 11.7 % to 0.9 %. The wedges are
visible directly in the AO buffer (`aoDebug = 1`), and entirely in the *contact*
term — the broad GTAO term is clean.

Two independent faults, both now fixed:

- **No bottom stop on the product.** `aoFloor` (0.17) and `contactFloor` (0.06)
  each bound their own term, but nothing bounded `ao * cao`, so the multiplier
  reaching the frame bottomed out at **0.010** — occlusion could remove 99 % of
  the light from a lit floor. `AOApplyPass` now applies `aoFloorTotal` (0.28)
  through a C1 soft knee, so the curve is the identity everywhere above
  ~0.46 and only the crush is removed.
- **The contact estimator was saturating.** It returns the fraction of 16 taps
  blocked; a gain of **2.5** saturated it at 0.45, so a boot crease and half an
  open floor tile both resolved to "fully occluded" and a third of the play area
  sat pinned in one narrow band. Because the term is also modulated by the *lit*
  frame's luma, every torch flicker and passing enemy moved that whole band at
  once — which is why it got worse as enemies closed in. `contactIntensity` is
  now **1.2**, which keeps headroom to the top of the range.

Measured walking the crypt with the pack engaged, three runs, play area only:

| | p95 frame-to-frame luma jump | near-black, peak frame |
|---|---|---|
| before | 0.075 / 0.061 / 0.066 | 43.1 % / 25.4 % / 21.7 % |
| after | 0.032 / 0.024 / 0.019 | 2.7 % / 4.3 % / 3.8 % |
| `aoApply` off (reference) | 0.008 / 0.016 / 0.025 | 1.3 % / 1.3 % / 1.5 % |

The fix puts the flashing at the same level as having the pass off entirely,
while grounding is retained (`shots/combat.png`). All eight scenarios still pass
`sheet.mjs --analyze` in AAA range.

**Ruled out along the way**, each by measurement rather than inspection: the
`ProbeVolume` irradiance grid, which snaps to whole cells
and so cannot swim; and `hero_cloak`, whose stale 40 m bounding sphere is a
culling inefficiency (worth fixing separately) but changes nothing in the
G-buffer.

### 1e. Pooled practicals casting shadows — FIXED

1d took the flashing down a long way but did not end it: the user still reported
black flashes "coming from one of the rocks" and a floor that "moves around the
hero". Both were the pooled point practicals casting shadows.

Measured on the live path with a **static camera**, in interleaved and
counterbalanced A/B blocks — interleaved because the metric drifts several
percent with combat state, which makes plain sequential ablation lie:

| point shadow slots | play area moving >0.15 luma per frame | near-black, peak | frame mean |
|---|---|---|---|
| casting | 10.5 % | 7.0 % | 0.319 |
| not casting | **0.41 %** | **2.7 %** | 0.362 |

6 of 6 blocks, and note the frame gets *brighter*: what the cube maps were
mostly contributing was a smear of self-shadowing across the party, not
readable contact. `TIER` in `render/Lighting.js` now allocates no shadowed
pooled slot at any tier. Walking a full lap of the crypt, the **worst** frame
now measures 4.2 % near-black with no wedge anywhere in it
(`shots/_debug/play/walk_worst.png`).

Grounding is unaffected because it was never coming from these maps: it comes
from the contact-AO stage rebuilt in 1d, the hero pool (see 1f), and
inverse-square falloff. The sun/CSM path is untouched, so exteriors still cast. Actor
separation is unchanged within its (large) frame-to-frame variance — mean SEP
across eight actors 0.123 casting vs 0.139 not casting, and the hero's own
separation improves, 0.066 to 0.127.

**Ruled out by the same test, so do not re-litigate:** the rebuild stagger
(period 2 vs 1), freezing the map after one build, `shadow.intensity`, the
shadow camera far plane, the PCF tap radius (2.6 / 1 / 0), shadow and normal
bias, pinning the light position, the characters as casters, and caster
visibility popping — the caster set is completely static (0 visibility flips in
40 frames, 1167 instances every frame).

**Not the cause, but fixed on its own merits:** shadow slot ownership thrashed
between braziers, so a slot's owner changed every few frames and its cube was
re-rasterised from a new position each time. `LightRig.select()` now ranks the
shadow tier with a real veto — a fresh incumbent is untouchable for
`SHADOW_MIN_TENURE`, after which a challenger needs to beat it by
`SHADOW_EVICT_MARGIN`. The previous multiplicative nudge inside a single global
sort could not hold a slot. Ownership is now stable indefinitely (0 changes in
39 frames, tenure climbing past 3.6 s). This did **not** move the churn, which
is what proved thrash was not the mechanism.

### 1f. The hero pool was being depth-clipped into a rectangle — FIXED

The separate half of the same report — "a square around the player on the floor,
and when he moves the floor tile moves with him" — and it really was the hero
grounding pool. **An earlier pass wrongly cleared it** by comparing its changed
pixel *count* against a frame-noise floor; that is the wrong test for a defect
whose complaint is a *shape*. Hiding the mesh and looking at the two frames
settles it in a second, and should have been the first thing done.

`nona.heroPool` is a flat 4-vertex 5.6 m quad parked 3.5 cm above the hero's feet
and tilted by a single `terrain.normalAt` sample. Its alpha ramp is radial and
does reach zero well inside the quad, so the quad's own edges are not the
problem — but a crypt floor is not terrain and is not flat. It is flagstones,
steps and rubble at different heights, and with `depthTest: true` every slab
standing proud of the quad's plane clipped it along that slab's straight edge.
The result is a hard-edged rectangle that slides across the floor with the hero.
Proved by lifting the quad 0.6 m: the hard edge vanishes while the darkening
stays.

**Fix:** the depth test is replaced by a soft comparison in the pool's own
fragment shader. It samples the G-buffer depth — which excludes the pool, since
the mesh is `noGBuffer`, so it is exactly the right comparison — and fades alpha
over `uSoft` (0.30 m) as a surface comes nearer than the quad. An intruding slab
now fades the pool instead of cutting it, while a column or a character in front
still takes it to zero, which is what the depth test was doing correctly. Tiers
with no G-buffer keep the plain depth test, since they have no depth to test
against.

The pool still does its job: it changes 4548 px (7.9 % of the sampled frame) by
more than 0.02, and actor separation is unchanged (hero SEP 0.125 vs 0.127).

---

## 2. Blown additive discs — `boss`, `night`, live `dungeon`

**Flag: "Uniform full-frame bloom haze"** · severity 8 · **open** · lane B

White, fully-clipped circular discs where loot glints, spell cores and impact
flashes stack. `night` has several at once around the hero; `boss` has them
around the arena rim. They read as untextured white circles, not as light.

**Fix:** cap the number of additive layers that can accumulate in one place and
clamp per-emitter contribution before the bloom threshold (0.838 scene-linear),
rather than letting N sprites sum past 1.0.

---

## 3. Overworld has no highlights — `overworld`

**Flag: "Milky lifted blacks or a washed-out grey frame"** (inverse — the frame
is uniformly dull) · severity 7 · **open** · lanes D + G

`sheet.mjs` is explicit: `p99 = 0.656`, the only scenario that fails its
check. Nothing in the frame is bright. The moor reads as one large dark mass
with no specular, no wet highlights, no rim on the ridgelines, and the sky —
much improved over the previous flat grey card — still does not put a bright
patch anywhere the terrain can catch.

**Fix:** a real value range on the moor. Wet rock specular, a brighter horizon
band the ridges can rim against, and aerial perspective so distance separates.

---

## 4. Enemy materials read as near-white — `combat`, `dungeon`

**Flag: "Untextured flat-color geometry"** · severity 6 · **open** · lane H

Skeletons in `combat.png` are pale grey-white blobs with very little surface
variation at gameplay distance. `actors.mjs` corroborates: body luma swings
from 0.004 to 0.977 across runs depending on which pixel is sampled, i.e. the
silhouette has almost no consistent internal value structure.

**Fix:** three frequency tiers on bone/cloth in `texgen`, additive only, so D
and E inherit it without editing anything.

---

## 5. Untextured blue-grey rubble — `closeup`, `combat`, `dungeon`

**Flags: "Untextured flat-color geometry"** AND **"Hard geometric intersection
lines where objects meet the floor"** · severity 8 · **open** · lane E

Upgraded from severity 6 after reviewing `closeup.png`, which is the frame that
shows this worst because it is the only one at character range. The broken
masonry scattered across the whole floor is flat blue-grey, effectively
untextured at that distance, with hard unblended edges where every block meets
the floor and no contact darkening. The hero standing in the middle of it is
well made by comparison — plate, mail, cape and a tabard emblem all read — so
the rubble drags the frame down badly.

Same geometry appears left of centre in `combat.png` and across the lower half
of `dungeon.png`.

**Fix:** real surface on the rubble material (the project generates all its
textures procedurally in `src/core/texgen/`), plus contact grounding where a
block meets the floor so the intersection is not a hard line.

---

## 6. Terrain tile grid — `dungeon`, `combat`

**Flag: "Obvious texture tiling / repetition visible in one glance"**
· severity 5 · **open** · lane D

Dead-straight continuous mortar joints run the full width of the frame in
`dungeon.png`. Sett width has not yet been measured against the 1.85 m hero
reference; that measurement is part of the Wave 2 exit criteria.

---

## 7. Routes were drawn through stone — live `dungeon` — FIXED

**No flag** (gameplay, not a frame defect) · severity 3 · **fixed**

The grid was answering a question about a *cell* when it was asked a question about a *point*.
`_refineClearance` probes nine positions per cell and keeps the ROOMIEST, which is the right
answer for "can a body get through here" and keeps 1.1 m corridors usable — but every consumer
then used it as the clearance *at the cell centre*, and in a doorway that does not line up with
the cell lattice the roomy point can be a quarter-cell away with the centre inside the jamb.

Measured on the default crypt, 260 planned routes over 2426 standable points:

| | before | after |
|---|---|---|
| routes passing through stone | 87.3 % | 1.9 % |
| segments where `lineOfSight` said clear but was not | 1606 | 0 |
| arrivals (distance-proportional time budget) | 96 % | 100 % |

Two changes, both in `NavGrid.js`, no new probing and no new memory beyond one `Uint8Array`:

- **Emit the point that was measured.** `_refineClearance` now records *which* of the nine
  probes won (`rep`), and `repX`/`repZ` reconstruct it. A* waypoints and `nearestFree` return
  that point instead of the cell centre, so a route aims at the gap rather than at the jamb
  beside it.
- **Cost the walk in `isFree`.** Clearance is a distance field, so it is 1-Lipschitz and cannot
  fall faster than a metre per metre. Subtracting the distance from the query point to the
  measured point turns the cell's answer into a sound lower bound for *this* point, for free.

The old note here said honest sub-cell routing needed finer cells near geometry. It did not:
it needed the grid to say where it had measured. Its warning against capping the detour ratio
still stands, and no cap was added.

Monsters were the risk — the best-of-nine optimism exists partly to stop brutes freezing in
doorways — so it was checked directly: 6 of 6 agents moving, mean 1.97 m in 8 s, zero new
`stuckHits`, `deferred` 0.

---

## 8. Dressing seals doorways, stranding part of the level — live `dungeon` — FIXED

**No flag** (gameplay, not a frame defect) · severity 2 · **fixed — this is the one the player hit**

Measured over 24 seeds, body-width connectivity of the generated crypt:

| | before | after |
|---|---|---|
| seeds that ship unreachable floor | 10 of 24 | 1 of 24 |
| mean stranded area | 278.3 m² | 20.4 m² |
| worst seed | 1271 m² | 489 m² |
| mean reachable area | 2098 m² | 2372 m² |

On the seed the player was standing in: 304 m² stranded across three pockets before,
22.7 m² in one after, measured against the real collision world at the hero's 0.34 m radius.

`Physics._wallsFromMask` builds the collision world out of the nav mask, so anything that calls
`blockRect`/`blockCircle` is not decoration — it is a full-height wall. Dressing does not check
where the doors are, so a sarcophagus, a column or the altar can be stamped into a portal, and
the rooms behind it leave the game. Nothing announces it; the floor is still drawn, which is
exactly what the player's screenshot shows — a visible gap that cannot be walked through.

On the shipped seed: **4 of 17 doorways sealed**, four regions totalling **~128 m² of 730 m²**
standable but unreachable, the worst being the crypt's south door covered by the altar's plinth
and stair pad (`_dress` centres the altar on the hall's back wall; a corridor arrived at the
same place, and nothing arbitrated).

**The fix** is `Layout.protectRect`. `_raisePortals` is the only code that knows a doorway's
true opening — `door.span` counts the stone between arches of a multi-arch portal as passable —
so as it stamps each jamb it reserves what is left between them plus 1.6 m of approach either
side. `blockCircle`/`blockRect` then refuse to close a reserved cell.

**Do not "improve" this by guarding the placements instead.** Two attempts died there. Skipping
a stamp changes the mask, which changes `clearanceAt`, which changes which candidates `scatter`
rejects — and `scatter` draws from the seeded stream on *every* attempt, accepted or not — so
the level re-rolls and lands wherever luck puts it. Drawing each piece's randoms unconditionally
is not enough, because the coupling is through the mask, not through the piece. Measured, main
reachable area on the shipped seed: 1100 m² untouched, **1394 m² refusing cells**, 861 m²
refusing placements. The version that edits placement is worse than doing nothing. Refusing
cells decides nothing and consumes no randomness, so the layout is bit-identical and strictly
more of it is joined up.

Two further traps, both paid for:

- **Round the reservation outward, not inward.** Inward is the tidier reading of "a reservation
  must be a subset of what it names", and it costs up to one cell of opening per side. The grid
  is 0.5 m and a body is 0.68 m, so tidiness took 280 m² of the crypt away from the player.
- **Assert at body width, not per cell.** The first assert flood-filled the raw mask and
  reported "one region, nothing stranded" for a level with 573 m² unreachable, because floor
  either side of a sarcophagus is walkable cell by cell and useless to anything 0.68 m wide.
  `Layout.connectivity(radius)` now filters on the clearance field `refreshClearance` has
  already computed, and generation warns when it is not all one piece.

**Known cost, reported not hidden.** A piece can still be *drawn* across a doorway it no longer
blocks — on the shipped seed that is the altar, whose plinth clips the hall's south portal, 46
cells. `refusedCells` counts it and generation names the offender on the console. The player can
clip that corner; the alternative was a third of the level behind a door that would not open.
Moving the altar is the obvious next step and is *not* free: it perturbs `clearanceAt` and so
re-rolls dressing, which needs the 24-seed sweep to justify, not one screenshot.

One seed in 24 still strands 489 m². Not chased.

---

## 9. Black holes scattered across the moor — `overworld`, `night`, live boot — FIXED

**Flag: "Black, blank, or single-color frame"** (local) · severity 7 · **fixed**

Dozens of soft, near-black discs, 1-3 m across, all over the open moor with nothing
standing above most of them. The live game boots to the moor, so this was the first
thing a player saw.

It was `decals:contact`. `_pick` ranks props by footprint (`rec.r`), and footprint is
not mass: a heather mat is 1.5 m wide and 5 cm tall. On `overworld`, **50 of the 72
prop slots** went to grass and heather, each stamped with the boulder-strength
two-lobe patch (0.62 + 0.40, capped at 0.80). Props already knew better — its own
blob layer skips `noBlob` / `carpet` / `mounted` kinds — but the contact layer never
asked.

**Fix:** `Props.contactWeight(rec)` applies the same gate and returns 0 for carpet
and mounted pieces, 1 for solid casters (`cast: true`), and 0.35 for open, low
dressing (bramble, roots, scree, bones). `_pick` skips weight 0, ranks by `r² · w`,
and the lobe strengths are scaled by `w`.

**How it was found, so nobody repeats the dead end:** hiding a group with
`.visible = false` proves nothing here — Props, Weather and Decals re-assert
visibility every frame, so the first round of "hide X, blobs remain" was testing
nothing. Hide by `material.visible = false` instead. Also ruled out by measurement:
every post pass, sun and CSM shadows, cloud shadows, terrain AO, puddles, wetness,
and NaN propagation.

## 10. Moor ridges read as snow — `overworld`, live boot — FIXED

**Flag: "Milky lifted blacks or a washed-out grey frame"** (the inverse case of
entry 3) · severity 6 · **fixed**

The moor `post` grade had `whitePoint 0.50` at `contrast 1.52` — a ~2.8x stretch
that clipped every lit slope to white. Rendering with the post chain bypassed shows
grey slate; the snow was entirely the grade. It satisfied entry 3's p99 check by
turning half the frame into highlight.

Now `whitePoint 0.56` at `contrast 1.40`. Measured: mean 0.321 → 0.265, p99 0.875
→ 0.75 (floor 0.72), near-black 4.2 % → 3.6 %. 0.62 looked best but measured p99
0.688 and failed the floor; 0.58 measured 0.719.

---

## Closed (no longer reproduces)

Verified against the current 8-scenario capture:

- **Boss arena is a flat brown gradient.** `boss.png` now shows laid radial
  slabs, scorch, per-slab jitter and braziers. `Arena.js` is 990 lines.
- **Overworld sky is a flat grey card brighter than the world.** `overworld.png`
  now has a graded, clouded sky darker than mid-frame. The horizon seam and the
  heightfield edge against void are gone.
- **Chroma grain at 0.28.** Now `0.04` with contrast-gated knees.
- **Telegraph decals ignore scene depth.** `Telegraph.js` reconstructs scene
  depth via `uDepth`/`uDepthOn`.
- **Inventory is flat UI rectangles.** `inventory.png` shows parchment,
  hammered metal frames and inset bevels.
- **Hero and enemies not visible.** `tools/actors.mjs` passes three consecutive
  live-path runs: every actor `visibleMeshes > 0`, `inFrame = true`,
  `hPx` 51-67, no occluder between camera and torso.

## Explicitly out of scope

Queue item 14 (draw calls, triangles, the 97 ms first-frame link hitch). It is
not an instant-fail flag and frame time is inside budget. The cascade fix
incidentally took draw calls from 6122 to 880 anyway.
