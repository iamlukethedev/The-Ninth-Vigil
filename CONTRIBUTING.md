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
npm run guard           # the rules above, enforced. Seconds. CI gates on this.
npm run guard:test      # proves the guard still catches what it claims. Seconds. CI gates on this.
node tools/smoke.mjs    # boots, loads all modules, links shaders, proves determinism
npm run check           # capture all 8 scenarios + objective frame analysis
```

`npm run check` runs the capture and the analysis together, and **fails** when a captured frame
trips a hard analysis rule (see below), so a broken frame cannot be reported as a green run.
`guard`, `guard:test` and `smoke` are what CI runs, plus the tool self-tests. `npm run check` needs a GPU and
is the one you run locally before claiming a visual fix.

### What `sheet.mjs --analyze` fails on, and what it only reports

The analysis exits **1** when a frame trips a *hard* rule: nearly black (`mean < 0.05`), too bright
(`mean > 0.5`, target 0.16-0.34), or a flat palette (`< 90` distinct colour buckets). Those mean the
frame is not a lit, textured scene — a rendering failure or a `CRITIC_RUBRIC.md` instant fail.

Everything else prints with an `[advisory]` tag and does **not** fail the run: lifted blacks,
no highlights, low contrast, blown-out highlights, oversaturation. Those describe a scene whose
value range drifted, which is a judgement call about the look and not proof the renderer broke; the
committed baselines currently sit close enough to those ranges that a legitimate atmosphere pass
would cross one. `--no-fail` exists to inspect a known-bad frame, and it prints every hard failure it
suppressed so a suppressed run can never be mistaken for a clean one.

Run `guard:test` too. The guard had a rule scope that matched nothing on Windows, so it
reported `OK` on a file containing four separate violations — and nothing tested it, so the gap
was invisible until someone ran the guard by hand. The test suite is what keeps that from
happening again; it is fast, it needs no browser, and it fails if the guard stops working.

The guard's rules live in `tools/guard-rules.mjs` and the runner in `tools/guard.mjs`. That
split is load-bearing: `guard.mjs` runs whenever it is invoked, so there is no "was I imported?"
branch that could misfire and exit 0 having scanned nothing. Keep it that way — a guard that
can silently decide to do nothing is a guard that reports OK forever.

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

### Measure the delta, don't argue about it

Steps 1-5 leave one thing to memory: *which* pixels moved. `tools/diff.mjs`
answers it as a number, against the eight committed baselines already in
`shots/`, and it needs no new dependency (PNG decode is `node:zlib`, in
`tools/png.mjs`):

```bash
# re-capture the scenario at the baseline's resolution and compare
node tools/diff.mjs --scenario=overworld

# compare a capture you already have (no dev server, no browser)
node tools/diff.mjs --scenario=overworld --new=shots/overworld.png

# machine-readable, for a script
node tools/diff.mjs --scenario=overworld --json
node tools/diff.mjs --all
```

It reports, per scenario and per 3x3 region: mean absolute channel delta, the
max channel delta, the percentage of pixels changed beyond the threshold, and
the **bounding box** of the change — printed as a `tools/crop.mjs` command so
step 2 is one paste away. It also writes a diff PNG to `shots/_diff/`
(gitignored): changed pixels lit red where the frame got brighter and blue where
it got darker, everything unchanged ghosted grey, so the image shows *where* and
*which way*.

The gate: exit **1** when more than `--allow-pct` (default **0** percent) of
pixels differ by more than `--pixel-delta` (default **2/255**, the noise floor),
exit **2** when it cannot compare at all (no baseline, undecodable file, size
mismatch), exit **0** otherwise. Default 0 is rule 3 taken at its word: two
captures of the same scenario at the same frame count are byte-identical, so any
pixel beyond the noise floor is a real change and not a re-encode artefact.
If your change is intended, do not raise the default: attach the diff PNG and
pass the tolerance you are accepting for that run (`--allow-pct=1.2`), and say
why in the PR.

Cross-machine captures are **not** a gate. A frame rendered on a different GPU
or a different rasteriser legitimately differs from a baseline captured on
someone else's machine; the number is informative, not a regression. That is
also why CI runs `tools/diff.test.mjs` against synthetic fixtures rather than
diffing the committed baselines.

**Equal hashes prove "unchanged"; unequal hashes prove nothing yet.** Two
captures on the same machine are byte-identical on the GPU paths measured so far
(macOS Metal, Windows D3D11), but a Linux ANGLE/Vulkan box has shown a 19-byte
run-to-run delta with the simulation hash unchanged (#26). So an `md5` match is a
valid pass, and a mismatch is a question for `tools/diff.mjs`, which reports how
much moved and where. `tools/shot.mjs` refuses a frame from a run that lost its
WebGL context and retries it once (`--retries=0` to fail at once): a recovered
context renders a different image, measured at 86% of pixels changed, so that
frame says nothing about the art.

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
