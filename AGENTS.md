# AGENTS.md

Entry point for an agent working on this repository. `CONTRIBUTING.md` is the
full guide and is written to be handed to an agent; this file only tells you the
order to read things in, the commands that actually work, and where the traps are.

Contributions from agents are the point of this project — say in the PR that you
are an agent and name the model.

## Read in this order

1. **`CONTRIBUTING.md`** — the four hard rules, how to prove a visual change, how
   to verify on the live path.
2. **`ENGINE_CONTRACT.md`** — binding: module lifecycle, engine services, event
   bus, determinism, performance budget, which bundled `three/addons/*` to use.
3. **`KNOWN_ISSUES.md`** — the authoritative open list, with the measured
   baseline table and the canonical world-scale table. It can lag `main`: check a
   row against `node tools/sheet.mjs --analyze` before you act on it.
4. **`CRITIC_RUBRIC.md`** — the 10 axes and 15 instant-fail flags the work is
   scored against.
5. **`HANDOFF.md`** — long-form brief. Start at the `START HERE` section for
   current state; the prioritised queue in it is a historical snapshot and is not
   a to-do list.

## Build, test, lint

```bash
npm ci                  # install exactly what package-lock pins
npm run dev             # http://localhost:5190  (?shot=combat, ?shot=boss)
npm run build           # vite build -> dist/
npm run guard           # lint: the hard rules, enforced. No browser. Seconds.
npm run guard:test      # proves the guard still catches what it claims
npm run smoke           # boot + determinism. Needs chromium; exits non-zero on failure
npm run check           # capture all 8 scenarios + objective frame analysis. Needs a GPU
node tools/sheet.mjs --analyze   # metrics for the committed shots/*.png only, no game boot
```

`guard` + `guard:test` are the `Convention guard` CI job; `smoke` is the
`Boot + determinism` CI job (run with `--software` on the GPU-less runner). Both
are required status checks on `main`. `npm run check` is a local tool, not a gate.

Verified on this checkout at HEAD `1f566b2`: `npm run guard` → `OK — 153 files,
1 html, 9 rules, 0 violations`; `npm run guard:test` → `OK — 13 cases`;
`npm run build` → `✓ built`; `node tools/sheet.mjs --analyze` → 8 frames, all in
range. `npm run smoke` and `npm run check` were **not** run (they boot Chromium).

## The four hard rules

Do not paraphrase these — `CONTRIBUTING.md` §"The four hard rules" is the binding
text. Rules 1–3 are enforced in CI (`guard` for 1, 2 and the `Math.random` half of
3; `smoke` for determinism); rule 4 is review-only, because a crash is not
something a static check can see.

1. **No new dependencies.** `three` only at runtime; `vite` and `playwright` are
   dev-only. Bundled `three/addons/*` are part of three, not a new dependency.
2. **No external assets.** No image/font/model/audio files, no CDN, no runtime
   fetch. Everything is generated in `src/core/texgen/` or code. `guard` checks it.
3. **Determinism is mandatory.** No `Math.random()` (use `engine.rand(seed)`), no
   `Date.now()`/`performance.now()` in simulation code (use `engine.clock.elapsed`).
   Two captures of the same scenario at the same frame count must be byte-identical.
4. **Everything degrades, never crashes.** A module that throws catches its own
   exception and disables itself instead of killing the frame loop.

## Repo map

```text
src/main.js            boot: creates the engine, applies a scenario, starts the loop
src/core/              Engine (services + lifecycle), Rand (PRNG/noise), AssetForge,
                       texgen/ (all procedural textures), Input, Profiler
src/game/              modules.js (the 21-module manifest + load order), Scenarios.js
                       (the 8 judged scenarios), AI/, Director.js, Loot.js, CameraRig.js
src/render/            Lighting, Sky, Atmosphere, Weather, RenderPipeline, passes/,
                       GradePass looks, LightRig
src/world/             Terrain, TerrainMaterial, Dungeon, dungeon/ (Layout, Pieces, Arena,
                       Spec), Props, props/ (Rock, Ruin, Fixtures, Human, Macabre), Water
src/chars/             Hero, CharacterMesh, Skeleton, Cloak, Bestiary, monsters/, NPCs
src/combat/            CombatSystem, Physics, physics/ (Character, Bodies, Ragdoll), HitFeel
src/vfx/               VFXSystem, emitters/, Decals, decals/ (Atlas, Surface, Telegraph)
src/ui/, src/audio/    HUD (minimap lives inside it), panels/, UITheme, UIAtlas; synthesis
                       + adaptive score
tools/                 the objective tooling (below)
shots/                 the 8 canonical frames — the only PNGs to judge against
dist/                  build output, gitignored
```

Integration spine — changing it is sometimes right, but say why in the PR:
`src/main.js`, `src/core/Engine.js`, `src/game/modules.js`, `src/game/Scenarios.js`,
`index.html`, `tools/*`.

## Objective tooling

Numbers before opinions. These are the only measurement instruments the project
has; use them instead of reasoning that a change "should" work.

| tool | what it answers |
|---|---|
| `node tools/guard.mjs` | do the hard rules hold? fast, no browser, CI-gated |
| `node tools/sheet.mjs --analyze` | per-scenario mean/sd/p01/p99/blk%/sat/colors for `shots/*.png` |
| `node tools/crop.mjs --in=shots/combat.png --x=0.5 --y=0.5 --w=0.25 --scale=4` | zoom the region that actually shows the defect |
| `node tools/shot.mjs --all --w=1600 --h=900` | recapture all 8 scenarios deterministically |
| `node tools/smoke.mjs` | boots, loads 21 modules, links shaders, proves determinism |
| `node tools/actors.mjs --port=5190` | is a character not drawing, off-frame, too small, or lost against the floor? |
| `node tools/live.mjs --port=5190` | the un-posed live boot, which the harness cannot reproduce |
| `node tools/debug.mjs`, `node tools/probe.mjs` | module load / shader-link console, live scene-graph inspection |

There is **no pixel-diff tool**. A before/after comparison is: capture, crop the
same region of both frames, look at both, and quote the numbers `sheet.mjs`
prints for each. `shots/_debug/` absorbs scratch captures; committed baselines in
`shots/` are never a scratch directory.

Thresholds `sheet.mjs` warns at (from `tools/sheet.mjs:103-111`): `p01 > 0.06`
lifted blacks; `p99 < 0.72` no highlights; `sd < 0.13` low contrast; `mean > 0.5`
too bright; `mean < 0.05` nearly black; `blownPct > 4` blown out (share of pixels
over 0.96, **not** the `blk%` column, which is true-black share); `meanSat > 0.52`
oversaturated; `colors < 90` flat palette.

## Verifying visually

`tools/shot.mjs` loads `?shot=X`, so `Terrain.init()` boots straight into the right
biome. The live game has no parameter: it boots to the moor and rebuilds later.
Anything that depends on that ordering is invisible to every canonical capture —
this has already cost two wasted rounds of "fixing black materials" that were
never broken. For anything the player can see:

```bash
npm run dev                                   # background, not a subshell
node tools/actors.mjs --port=5190             # no --scenario = live default boot
node tools/live.mjs   --port=5190
```

Restart the dev server for a clean read (the first run catches Vite mid-compile
and reports the hero at `(0,0,0)`), and run the oracle three times — enemies
legitimately churn. Put both crops in the PR, with the numbers.

## Commits and PRs

One concern per PR. Explain *why* in the commit body. Never force-push, never
rewrite history, never delete a branch: a stale branch is rescued by
`git merge upstream/main`. Fork and open a PR rather than pushing to `main`;
review is expected but is **not** currently enforced by the ruleset — see
`.github/CODEOWNERS`.
