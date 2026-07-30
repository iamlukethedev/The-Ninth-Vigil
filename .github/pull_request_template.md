## What and why

<!-- What changes, and why. The diff already says what — the useful part is why,
     and what you tried that did not work. -->

## How it was verified

<!-- Be specific. "Looks right" is the failure mode this project has been bitten by
     most: seven of thirteen defects once came back from review still present at the
     same pixel coordinates, after all of them had been reported fixed. -->

- [ ] `node tools/guard.mjs` passes
- [ ] `node tools/smoke.mjs` passes
- [ ] For a visual change: `npm run check` run locally, and the affected scenario
      still passes `sheet.mjs --analyze`

### Visual changes only

<!-- Delete this section if nothing the player sees has changed. -->

Before and after crops of the **same region at the same scale**
(`node tools/crop.mjs --in=shots/<scenario>.png --x= --y= --w= --scale=4`):

| before | after |
|---|---|
|  |  |

Measured numbers this change claims to move — luma, pixel size, solid-black
percentage, draw calls, whatever is relevant:

```
before:
after:
```

- [ ] Verified on the **live path** (`npm run dev`, plus `tools/actors.mjs` /
      `tools/live.mjs`), not only in the harness — the harness cannot see an entire
      class of bug

## Rules

- [ ] No new dependencies
- [ ] No external assets — anything new is generated in `src/core/texgen/`
- [ ] Determinism intact: no `Math.random()`, no wall-clock time in simulation code
- [ ] Respects the design rules in the README (escalation named toward light, no
      system named for a vice, references stay submerged)
