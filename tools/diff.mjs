#!/usr/bin/env node
/**
 * Pixel diff — compares a capture against the committed baseline for the same
 * scenario, and writes a diff image that shows where it moved.
 *
 *   node tools/diff.mjs --scenario=overworld
 *   node tools/diff.mjs --scenario=overworld --new=shots/overworld.png   # compare files, no capture
 *   node tools/diff.mjs --scenario=overworld --out=shots/_diff --json
 *   node tools/diff.mjs --all                                            # every committed baseline
 *
 * WHY THIS EXISTS. `CONTRIBUTING.md` requires every visual change to "prove
 * visual changes in pixels" with a before/after of the same region and the
 * measured numbers. The repository already ships the "before" — the eight
 * committed PNGs in `shots/` — and nothing ever compared a new capture against
 * them, so the rule was honour-system: `tools/sheet.mjs` measures a frame in
 * isolation and has no notion of changed versus unchanged.
 *
 * WHY PIXELS AND NOT A HASH. The README already records the objection to a
 * stored hash: it "would mostly generate 'just update the expected value'
 * commits", because a hash collapses "the torch moved and the frost is gone"
 * and "everything is subtly wrong" into the same opaque string. A diff keeps
 * that information — a legitimate change produces a visible, reviewable delta,
 * and the delta is the evidence. So: ship the diff, keep the pixels, drop the
 * hash.
 *
 * WHAT FAILS THE BUILD. `--allow-pct` is the documented threshold: the share
 * of pixels allowed to differ by more than `--pixel-delta` before the exit
 * code is non-zero. It defaults to 0, and that default is not strictness for
 * its own sake — CONTRIBUTING.md rule 3 promises that "two captures of the
 * same scenario stepped the same number of frames must be byte-identical", and
 * this repo's determinism is the property that makes a pixel change
 * attributable to a code change at all. On the machine that owns the baseline,
 * a clean build diffs to 0.000 % (measured, see the PR). Anything above zero
 * is therefore a real change and deserves a human look; if the change is
 * intended, `--allow-pct` records the tolerance you are accepting, and the
 * diff PNG is your evidence.
 *
 * CROSS-MACHINE COMPARISONS ARE NOT A GATE. A capture from a different GPU or
 * a different rasteriser will differ from a baseline captured on the author's
 * machine. That number is real and useful — it says the two renderers disagree
 * — but it is not a regression, so CI runs `tools/diff.test.mjs` against
 * synthetic fixtures, and the committed baselines are compared on the machine
 * that owns them (or with `--allow-pct` set from a measured drift, recorded in
 * the PR that sets it).
 *
 * DECODING. `tools/png.mjs` decodes with `node:zlib` and no new dependency
 * (the project's first hard rule), and it is verified byte-identical to
 * Chromium's decoder against all eight committed baselines.
 *
 * REGIONS. A whole-frame percentage hides a small, sharp defect in a corner:
 * one lit pixel in a 1600x900 frame is 0.00007 %, which reads as "nothing
 * changed". So the frame is also divided into a `--grid` (default 3x3) and
 * every cell reports its own numbers, plus the bounding box of every changed
 * pixel — that is the "where" a reviewer needs to crop.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, basename, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodePng, encodePng } from './png.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'shots');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

/* Every PNG the harness has written is 8-bit type 2 or 6, which is what
   png.mjs supports; a file it cannot read is an error worth stopping for. */
const PIXEL_DELTA = Number(args['pixel-delta'] ?? 2);  // channel units tolerated per pixel (2/255 ≈ noise floor)
const ALLOW_PCT = Number(args['allow-pct'] ?? 0);      // % of pixels allowed to exceed PIXEL_DELTA
const SEVERE_DELTA = Number(args['severe-delta'] ?? 16); // "changed a lot", reported separately
const GRID = Math.max(1, Number(args.grid ?? 3));
const JSON_OUT = !!args.json;
const OUT_DIR = resolve(ROOT, String(args.out ?? 'shots/_diff'));

/* --- measurement -------------------------------------------------------- */

/**
 * Compare two decoded frames.
 *
 * The delta per pixel is the largest absolute channel difference, not the
 * Euclidean distance: a channel that moved by 90 is a visible edge whether or
 * not the other two moved with it, and max-channel is the number a threshold
 * can be stated in without hand-waving.
 */
export function compareFrames(a, b, opts = {}) {
  const pixelDelta = opts.pixelDelta ?? PIXEL_DELTA;
  const severeDelta = opts.severeDelta ?? SEVERE_DELTA;
  const grid = opts.grid ?? GRID;

  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, baseline: [a.width, a.height], candidate: [b.width, b.height] };
  }

  const { width: w, height: h } = a;
  const total = w * h;
  const diff = new Uint8Array(total * 4);

  const cells = Array.from({ length: grid * grid }, () => ({ changed: 0, pixels: 0, deltaSum: 0 }));
  let changed = 0, severe = 0, deltaSum = 0, maxDelta = 0, lumaSum = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowCell = Math.min(grid - 1, Math.floor((y * grid) / h)) * grid;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const dr = Math.abs(a.rgba[o] - b.rgba[o]);
      const dg = Math.abs(a.rgba[o + 1] - b.rgba[o + 1]);
      const db = Math.abs(a.rgba[o + 2] - b.rgba[o + 2]);
      const d = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;

      const cell = cells[rowCell + Math.min(grid - 1, Math.floor((x * grid) / w))];
      cell.pixels++;
      cell.deltaSum += d;

      deltaSum += d;
      if (d > maxDelta) maxDelta = d;

      /* Luma delta is signed, so the report can say which way the frame moved
         rather than only that it moved. */
      const lumaA = 0.2126 * a.rgba[o] + 0.7152 * a.rgba[o + 1] + 0.0722 * a.rgba[o + 2];
      const lumaB = 0.2126 * b.rgba[o] + 0.7152 * b.rgba[o + 1] + 0.0722 * b.rgba[o + 2];
      lumaSum += lumaB - lumaA;

      if (d > pixelDelta) {
        changed++;
        cell.changed++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (d > severeDelta) severe++;

        /* Changed pixels are lit: red where the candidate is brighter, blue
           where it is darker, so the image shows the DIRECTION of a change and
           not just that one happened. Magnitude is amplified — a 4/255 change
           is real and worth seeing, and it is otherwise invisible. */
        const mag = Math.min(255, 48 + d * 4);
        const brighter = (b.rgba[o] + b.rgba[o + 1] + b.rgba[o + 2]) > (a.rgba[o] + a.rgba[o + 1] + a.rgba[o + 2]);
        diff[o] = brighter ? mag : 16;
        diff[o + 1] = 26;
        diff[o + 2] = brighter ? 16 : mag;
        diff[o + 3] = 255;
      } else {
        /* Unchanged pixels are dimmed to a grey ghost, so the change reads as
           the subject of the image instead of competing with the original. */
        const g = (0.2126 * a.rgba[o] + 0.7152 * a.rgba[o + 1] + 0.0722 * a.rgba[o + 2]) * 0.22;
        diff[o] = diff[o + 1] = diff[o + 2] = g;
        diff[o + 3] = 255;
      }
    }
  }

  const bbox = changed
    ? {
        x0: minX, y0: minY, x1: maxX, y1: maxY,
        w: maxX - minX + 1, h: maxY - minY + 1,
        /* Normalised, so it can be pasted straight into
           `node tools/crop.mjs --x=.. --y=.. --w=..`. */
        x: +(minX / w).toFixed(4), y: +(minY / h).toFixed(4),
        wFrac: +((maxX - minX + 1) / w).toFixed(4), hFrac: +((maxY - minY + 1) / h).toFixed(4),
      }
    : null;

  return {
    sizeMismatch: false,
    width: w,
    height: h,
    total,
    changed,
    changedPct: +((100 * changed) / total).toFixed(4),
    severe,
    severePct: +((100 * severe) / total).toFixed(4),
    meanDelta: +(deltaSum / total).toFixed(3),
    maxDelta,
    lumaDelta: +(lumaSum / total).toFixed(4),
    bbox,
    regions: cells.map((c, i) => ({
      row: Math.floor(i / grid),
      col: i % grid,
      changedPct: c.pixels ? +((100 * c.changed) / c.pixels).toFixed(4) : 0,
      meanDelta: c.pixels ? +(c.deltaSum / c.pixels).toFixed(3) : 0,
    })),
    diff,
  };
}

/* --- capture ------------------------------------------------------------ */

function capturePng(scenario, width, height) {
  const out = join(OUT_DIR, '_new', `${scenario}.png`);
  mkdirSync(dirname(out), { recursive: true });
  const shotArgs = [
    resolve(ROOT, 'tools/shot.mjs'),
    `--scenario=${scenario}`,
    `--out=${out.slice(ROOT.length + 1).replace(/\\/g, '/')}`,
    `--w=${width}`,
    `--h=${height}`,
  ];
  if (args.frames) shotArgs.push(`--frames=${args.frames}`);
  /* Pass the boot budget through: a GPU-less host needs minutes, shot.mjs's
     default 120 s would give up mid-build. */
  if (args.timeout) shotArgs.push(`--timeout=${args.timeout}`);

  const r = spawnSync(process.execPath, shotArgs, { cwd: ROOT, encoding: 'utf8' });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 || !existsSync(out)) {
    throw new Error(`capture failed (${r.status}):\n${log.trim()}`);
  }
  return { path: out, log };
}

/* --- main --------------------------------------------------------------- */

const scenarios = args.all
  ? readdirSync(SHOTS)
      .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
      .map((f) => basename(f, '.png'))
      .sort()
  : [String(args.scenario ?? '')];

if (!scenarios[0]) {
  console.error('usage: node tools/diff.mjs --scenario=<name> [--new=<png>] [--out=shots/_diff] [--json]');
  console.error('       node tools/diff.mjs --all');
  process.exit(2);
}

const results = [];
let failed = false;
let errored = false;

for (const scenario of scenarios) {
  const basePath = resolve(ROOT, String(args.base ?? join('shots', `${scenario}.png`)));

  if (!existsSync(basePath)) {
    results.push({ scenario, status: 'no-baseline', base: basePath.slice(ROOT.length + 1) });
    errored = true;
    continue;
  }

  let base, candidate, candidatePath, captureLog = null;
  try {
    base = decodePng(readFileSync(basePath));
  } catch (e) {
    results.push({ scenario, status: 'bad-baseline', error: e.message });
    errored = true;
    continue;
  }

  try {
    if (args.new) {
      candidatePath = resolve(ROOT, String(args.new));
      if (!existsSync(candidatePath)) throw new Error(`--new file not found: ${candidatePath}`);
    } else {
      /* No candidate given: capture one, at the BASELINE's resolution. The
         committed frames are a mix of 1600x900 and 1920x1080, and a capture at
         the wrong size cannot be compared at all. */
      const cap = capturePng(scenario, base.width, base.height);
      candidatePath = cap.path;
      captureLog = cap.log;
    }
    candidate = decodePng(readFileSync(candidatePath));
  } catch (e) {
    results.push({ scenario, status: 'candidate-failed', error: e.message, captureLog });
    errored = true;
    continue;
  }

  const cmp = compareFrames(base, candidate, { pixelDelta: PIXEL_DELTA, severeDelta: SEVERE_DELTA, grid: GRID });

  if (cmp.sizeMismatch) {
    results.push({
      scenario, status: 'size-mismatch',
      baseline: cmp.baseline, candidate: cmp.candidate,
      base: basePath.slice(ROOT.length + 1),
      newPath: candidatePath.slice(ROOT.length + 1),
    });
    errored = true;
    continue;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const diffPath = join(OUT_DIR, `${scenario}-diff.png`);
  writeFileSync(diffPath, encodePng(cmp.width, cmp.height, cmp.diff));

  const over = cmp.changedPct > ALLOW_PCT;
  if (over) failed = true;

  results.push({
    scenario,
    status: cmp.changed === 0 ? 'identical' : over ? 'changed' : 'within-tolerance',
    base: basePath.slice(ROOT.length + 1).replace(/\\/g, '/'),
    candidate: candidatePath.slice(ROOT.length + 1).replace(/\\/g, '/'),
    width: cmp.width,
    height: cmp.height,
    total: cmp.total,
    changed: cmp.changed,
    changedPct: cmp.changedPct,
    severe: cmp.severe,
    severePct: cmp.severePct,
    meanDelta: cmp.meanDelta,
    maxDelta: cmp.maxDelta,
    lumaDelta: cmp.lumaDelta,
    bbox: cmp.bbox,
    regions: cmp.regions,
    diffPng: diffPath.slice(ROOT.length + 1).replace(/\\/g, '/'),
    captureLog: captureLog ? captureLog.trim().split('\n') : null,
  });
}

/* --- report ------------------------------------------------------------- */

if (JSON_OUT) {
  console.log(JSON.stringify({
    ok: !failed && !errored,
    threshold: { pixelDelta: PIXEL_DELTA, allowPct: ALLOW_PCT, severeDelta: SEVERE_DELTA, grid: GRID },
    results,
  }, null, 2));
  process.exit(errored ? 2 : failed ? 1 : 0);
}

const pct = (n) => `${String(n).padStart(6)}%`;

for (const r of results) {
  if (r.status === 'no-baseline') {
    console.log(`  ${r.scenario.padEnd(11)} ERROR no baseline at ${r.base}`);
    continue;
  }
  if (r.status === 'bad-baseline') {
    console.log(`  ${r.scenario.padEnd(11)} ERROR cannot decode baseline: ${r.error}`);
    continue;
  }
  if (r.status === 'candidate-failed') {
    console.log(`  ${r.scenario.padEnd(11)} ERROR capture: ${r.error.split('\n')[0]}`);
    continue;
  }
  if (r.status === 'size-mismatch') {
    console.log(`  ${r.scenario.padEnd(11)} ERROR size mismatch: baseline ${r.baseline.join('x')} vs candidate ${r.candidate.join('x')}`);
    console.log(`                     capture at the baseline size, or pass --new=<png> of the same size`);
    continue;
  }

  const mark = r.status === 'identical' ? '✓' : r.status === 'within-tolerance' ? '~' : '!';
  console.log('');
  console.log(`  ${mark} ${r.scenario}  ${r.width}x${r.height}`);
  console.log(`      baseline   ${r.base}`);
  console.log(`      candidate  ${r.candidate}`);
  console.log(`      changed    ${pct(r.changedPct)} of pixels beyond ${PIXEL_DELTA}/255  (${r.changed} of ${r.total})`);
  console.log(`      severe     ${pct(r.severePct)} beyond ${SEVERE_DELTA}/255`);
  console.log(`      delta      mean |Δ| ${r.meanDelta}/255   max Δ ${r.maxDelta}   mean luma ${r.lumaDelta > 0 ? '+' : ''}${r.lumaDelta}`);
  if (r.bbox) {
    console.log(`      bbox       x ${r.bbox.x0}..${r.bbox.x1}  y ${r.bbox.y0}..${r.bbox.y1}  (${r.bbox.w}x${r.bbox.h})`);
    console.log(`                 crop --x=${r.bbox.x} --y=${r.bbox.y} --w=${r.bbox.wFrac} --h=${r.bbox.hFrac}`);
  } else {
    console.log('      bbox       — no pixel differs beyond tolerance');
  }

  const grid = Math.sqrt(r.regions.length) | 0;
  console.log(`      regions    ${grid}x${grid}  %changed / mean |Δ|`);
  for (let row = 0; row < grid; row++) {
    const line = r.regions
      .slice(row * grid, row * grid + grid)
      .map((c) => `${String(c.changedPct).padStart(6)}% / ${String(c.meanDelta).padStart(5)}`)
      .join('   ');
    console.log(`        row ${row}  ${line}`);
  }
  console.log(`      diff png   ${r.diffPng}`);
}

console.log('');
if (errored) {
  console.log('diff: ERROR — could not compare one or more scenarios (see above).');
  process.exit(2);
}
if (failed) {
  console.log(`diff: FAILED — a frame changed by more than --allow-pct=${ALLOW_PCT}% of its pixels.`);
  console.log(`      The diff PNGs above show where, and red/blue is brighter/darker.`);
  console.log(`      If the change is intended, attach the diff and record the tolerance you accept.`);
  process.exit(1);
}
console.log(`diff: OK — every compared frame is within --allow-pct=${ALLOW_PCT}% (pixel delta ≤ ${PIXEL_DELTA}/255).`);
