# Contributing to The Ninth Vigil

Thanks for looking. This project has some unusual rules, and they are unusual for
reasons — each one below cost real time to learn. Reading this first will save you
a rejected patch.

**Contributions from AI agents are welcome and are the point.** This game was built
end to end by [Hermes](https://github.com/NousResearch/hermes-agent) agents, and the
invitation is open: point your own agent at this repository and let it work. This
document is written to be handed to an agent directly, so it states things a human
would take for granted.

Two additions if you are an agent, or running one:

- **Say so in the PR, and name the agent.** Not a disclaimer — comparing how
  different agents perform against the same contract and rubric is part of the
  experiment.
- **If you got stuck somewhere this documentation should have carried you, open an
  issue about that too.** A gap here is a real defect; most integration failures on
  this project traced back to something `ENGINE_CONTRACT.md` did not say.

## Before you write code

Read **`ENGINE_CONTRACT.md`**. It is short and it is binding: module lifecycle,
the engine services you may use, the event bus, the performance budget, and the
art-direction bible. Then skim `src/core/Engine.js`, `src/core/Rand.js` and
`src/game/modules.js` to see the spine everything is written against.

If you are fixing a visual defect, read the relevant entry in
**`KNOWN_ISSUES.md`** first. Several defects there were "fixed" more than once by
people who did not check whether the fix landed, and the entries record the
measurements that prove what is and is not still broken.

## Setup

```bash
npm install
npm run dev            # http://localhost:5190
```

## The four hard rules

**1. No new dependencies.** The list is `three`, `vite`, `playwright`. That is
all, forever. Bundled `three/addons/*` are part of three and are not new
dependencies — prefer them over hand-rolling. `ENGINE_CONTRACT.md` lists the ones
worth knowing about.

**2. No external assets, ever.** No image files, no fonts, no models, no audio
files, no CDN links, no runtime fetches. Every texture, mesh, animation and sound
is generated procedurally. If your fix seems to need an asset, the fix is a
generator in `src/core/texgen/`. This is the constraint the project exists to
honour, and "just add a PNG" is the one change that will never be merged.

**3. Determinism is mandatory.** No `Math.random()` — use `engine.rand(seed)`. No
`Date.now()` or `performance.now()` in simulation code — use
`engine.clock.elapsed`. Two captures of the same scenario stepped the same number
of frames must be byte-identical.

This is not about netcode. It is what makes the visual review falsifiable: if
frames drift between runs, you cannot attribute a pixel change to your change,
and every visual fix becomes an opinion. `performance.now()` does appear in a few
places as a *budget timer* for work-splitting — that is allowed, guarded by a
`typeof` check, and must never feed simulation state.

**4. Everything degrades, never crashes.** A module that throws must catch its own
exception and disable itself rather than killing the frame loop.

## Run the checks

```bash
node tools/guard.mjs    # the rules above, enforced. Seconds. CI gates on this.
node tools/smoke.mjs    # boots, loads all modules, links shaders, proves determinism
npm run check           # capture all 8 scenarios + objective frame analysis
```

`guard` and `smoke` are what CI runs. `npm run check` needs a GPU and is the one
you run locally before claiming a visual fix.

## Proving a visual change

This is the part most likely to get a PR sent back, so it is worth being explicit.

**The dominant failure mode on this project is changing code, reasoning that it
should work, and reporting success while the defect is untouched.** Seven of
thirteen defects once came back from a review still present at the same pixel
coordinates, after all of them had been reported fixed.

So for any change that claims to alter what the player sees:

1. Capture the affected scenario *before* your change.
2. Zoom the exact region — `node tools/crop.mjs --in=shots/combat.png --x=0.5 --y=0.5 --w=0.25 --scale=4`.
   A 1600x900 frame viewed whole hides the defects that matter.
3. **Look at it.** Make the change.
4. Re-capture and re-crop the identical region. Look again.
5. Put both crops in the PR, and state the measured numbers your change claims to
   move — luma, pixel size, draw calls, solid-black percentage, whatever is
   relevant.

If the defect is still visible in the after crop, you are not done.

### Verify on the live path, not just the harness

`tools/shot.mjs` loads `?shot=X`, so `Terrain.init()` reads the query parameter
and boots straight into the right biome. **The live game has no parameter**, boots
to the moor, and only rebuilds to the correct biome later. Any bug that depends on
that ordering is invisible to every screenshot the harness takes.

This is not hypothetical. A player once reported "I can't see my hero or any
enemies" while every canonical capture showed them rendering perfectly — the crypt
geometry had stayed baked on the moor heightfield while actors were placed on the
new one, so every character stood 3.5 m *below the drawn floor*. Two rounds of
"fix the black materials" chased a defect that did not exist.

For anything a player can see:

```bash
npm run dev
node tools/actors.mjs --port=5190    # no --scenario, so you get the live default boot
node tools/live.mjs   --port=5190
```

Two gotchas: restart the dev server for a clean read, because the first run or two
against a cold Vite catches the page mid-compile and reports the hero at
`(0,0,0)`; and enemies legitimately churn, because the hero auto-fights and the
Director respawns, so never conclude "the collection is broken" from a single
empty read.

## Rendering: two ways to break everything

**Sixteen fragment samplers is a hard GPU limit and this project sits near it.**
Exceed it and shaders fail to *link*, at which point WebGL draws those materials
**flat white** — so the frame looks bright rather than broken, and the objective
metrics can still land in range. This has happened twice. If you add material
maps, watch the console for `texture image units count exceeds` and
`program not valid`. `tools/smoke.mjs` checks for both.

**Extend stock materials with `onBeforeCompile`** rather than rewriting them.

## Design rules for content

The fiction has rules too, because the premise is the point of the project and it
does not survive well-meaning additions. Full reasoning is in the README, but in
short: escalation is always named toward light and never toward damnation (a
"Torment" tier is a rejected patch); no system carries a vice's name; do not add
mechanics whose tension is the possibility of total loss; and **references stay
submerged** — every string must read as plain gothic flavour to someone who does
not recognise the source, so no chapter-and-verse citations in player-facing text.

Engine identifiers use a `nona` prefix, not `vigil`, because `vigil` is already a
lore token in the item tables.

## Files you should not edit

`src/main.js`, `src/core/Engine.js`, `src/game/modules.js`,
`src/game/Scenarios.js`, `index.html`, and `tools/*` are the integration spine
every module is written against. Changing them is sometimes right, but say why in
the PR.

## If you are working in parallel

**Serialize by file ownership.** When six fixers once ran at the same time, two
both owned `Decals.js` and two both owned `Lighting.js`. Whoever wrote last won,
and the other work silently vanished. Partition files strictly.

## Commits and PRs

Explain *why*, not what — the diff already says what. Where a line is
load-bearing for a non-obvious reason, or where you rejected an approach that
looks better than what you shipped, say so in a comment; that is why the codebase
reads the way it does.

Small PRs, one concern each.
