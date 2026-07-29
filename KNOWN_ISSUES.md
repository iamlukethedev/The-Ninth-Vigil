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

## 1. Hard-edged black wedges — `boss`, live `dungeon`

**Flag: "Black, blank, or single-color frame"** · severity 9 · **open**

The headline defect, and the reason the hero and enemies were reported as "not
showing". Large, straight-sided, un-feathered black polygons cross the play
area and swallow whatever is behind them.

This turned out to be **three stacked causes**, not one. The first is fixed;
two remain.

### 1a. Four sun cascades in a sunless interior — FIXED (`d2aad35`)

`crypt`/`hell`/`arena` are `sunless`, but their fictional "skylight" key was
casting four CSM cascades through a real ceiling at ~7.3 m. Confirmed by
toggling `castShadow` on the four `sanctum.csm.*` lights on a live frame:
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
