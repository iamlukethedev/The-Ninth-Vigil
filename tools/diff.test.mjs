#!/usr/bin/env node
/**
 * Pixel-diff self-test — proves tools/diff.mjs measures and fails as documented.
 *
 *   node tools/diff.test.mjs
 *
 * WHY THIS EXISTS. `tools/diff.mjs` is a gate: its whole value is the exit code
 * a reviewer (and CI) trusts. A gate that silently reports "identical" on a
 * changed frame is worse than no gate, because it converts an unchecked claim
 * into a machine-checked one. So the diff tool gets the same treatment as the
 * guard: synthetic fixtures, a real subprocess run, asserted exit codes.
 *
 * Fixtures are generated in a TEMP dir and never written into `shots/` — a test
 * that pollutes the baselines it is testing would be a defect of its own. The
 * one file it reads from the repo is a committed baseline, decoded and
 * spot-checked, so a decoder regression cannot slip through as "images differ".
 *
 * Exit 0 = every case behaves as specified. Exit 1 = a case regressed.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIFF = join(ROOT, 'tools', 'diff.mjs');

const W = 96;
const H = 64;

/* --- fixture helpers ---------------------------------------------------- */

/** A flat dark frame with an optional bright rectangle, as RGBA. */
function frame({ rect = null, bg = [20, 22, 26] } = {}) {
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  if (rect) {
    const { x, y, w, h, c } = rect;
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const o = (py * W + px) * 4;
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      }
    }
  }
  return rgba;
}

function writePng(path, rgba) {
  writeFileSync(path, encodePng(W, H, rgba));
  return path;
}

/**
 * Run the real CLI and return its exit code plus the parsed --json payload.
 *
 * `execFileSync` throws on a non-zero exit, which is the normal outcome for
 * every failing case here, so the throw is the result — not a crash.
 */
function run(args) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [DIFF, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = String(e.stdout ?? '');
    code = e.status ?? 1;
    if (!out && e.stderr) out = String(e.stderr);
  }
  let json = null;
  try { json = JSON.parse(out); } catch { /* a case that expects a crash has no JSON */ }
  return { code, out, json };
}

/* --- cases -------------------------------------------------------------- */

const cases = [];
const testCase = (name, fn) => cases.push({ name, fn });

testCase('identical frames -> zero delta, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-same-'));
  try {
    const a = writePng(join(dir, 'a.png'), frame({ rect: { x: 10, y: 10, w: 20, h: 12, c: [180, 160, 120] } }));
    const b = writePng(join(dir, 'b.png'), frame({ rect: { x: 10, y: 10, w: 20, h: 12, c: [180, 160, 120] } }));
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${b}`, `--out=${join(dir, 'out')}`, '--json']);
    const res = r.json?.results?.[0];
    if (r.code !== 0) return `expected exit 0, got ${r.code}`;
    if (!res || res.changed !== 0) return `expected changed=0, got ${JSON.stringify(res?.changed)}`;
    if (res.status !== 'identical') return `expected status identical, got ${res.status}`;
    if (res.bbox !== null) return `expected no bbox, got ${JSON.stringify(res.bbox)}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('one changed pixel -> detected, exit non-zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-pixel-'));
  try {
    const a = writePng(join(dir, 'a.png'), frame());
    const b = frame();
    const o = (37 * W + 61) * 4;
    b[o] = 255; b[o + 1] = 0; b[o + 2] = 255;
    writePng(join(dir, 'b.png'), b);
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${join(dir, 'b.png')}`, `--out=${join(dir, 'out')}`, '--json']);
    const res = r.json?.results?.[0];
    if (r.code !== 1) return `expected exit 1, got ${r.code}`;
    if (!res) return 'no JSON payload';
    if (res.changed !== 1) return `expected changed=1, got ${res.changed}`;
    /* Largest channel move here is R 20 -> 255 = 235, so max delta must be 235.
       Asserting the measured number (rather than "> 0") is what catches a
       reducer that reports the mean where it claims to report the max. */
    if (res.maxDelta !== 235) return `expected maxDelta=235, got ${res.maxDelta}`;
    if (res.bbox?.x0 !== 61 || res.bbox?.y0 !== 37 || res.bbox?.w !== 1 || res.bbox?.h !== 1) {
      return `expected a 1x1 bbox at 61,37, got ${JSON.stringify(res.bbox)}`;
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a shifted prop -> bbox spans both positions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-shift-'));
  try {
    const rect = { w: 16, h: 16, c: [200, 180, 120] };
    const a = writePng(join(dir, 'a.png'), frame({ rect: { ...rect, x: 8, y: 8 } }));
    /* Same prop, ten pixels to the right: the change a "did the torch move?"
       question actually looks like. The bbox must cover where it left AND
       where it arrived, or a reviewer crops the wrong half. */
    const b = writePng(join(dir, 'b.png'), frame({ rect: { ...rect, x: 18, y: 8 } }));
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${b}`, `--out=${join(dir, 'out')}`, '--json']);
    const res = r.json?.results?.[0];
    if (r.code !== 1) return `expected exit 1, got ${r.code}`;
    const bb = res?.bbox;
    if (!bb) return 'expected a bbox, got none';
    /* Union of x 8..23 (vacated) and 18..33 (arrived) is 8..33. */
    if (bb.x0 !== 8 || bb.x1 !== 33) return `expected x0=8 x1=33, got x0=${bb.x0} x1=${bb.x1}`;
    if (bb.w !== 26) return `expected w=26, got ${bb.w}`;
    if (bb.y0 !== 8 || bb.h !== 16) return `expected y0=8 h=16, got y0=${bb.y0} h=${bb.h}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a sub-threshold change -> within tolerance, exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-noise-'));
  try {
    const a = writePng(join(dir, 'a.png'), frame());
    /* 1/255 on every channel is below the documented 2/255 noise floor, so a
       re-encode or a round-trip must not red the build. */
    const noisy = frame({ bg: [21, 23, 27] });
    const b = writePng(join(dir, 'b.png'), noisy);
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${b}`, `--out=${join(dir, 'out')}`, '--json']);
    const res = r.json?.results?.[0];
    if (r.code !== 0) return `expected exit 0, got ${r.code}`;
    if (res?.changed !== 0) return `expected changed=0, got ${res?.changed}`;
    if (res?.maxDelta !== 1) return `expected maxDelta=1 (measured but not flagged), got ${res?.maxDelta}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a missing baseline -> exit 2, not a pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-nobase-'));
  try {
    const b = writePng(join(dir, 'b.png'), frame());
    const r = run(['--scenario=fixture', `--base=${join(dir, 'nope.png')}`, `--new=${b}`, `--out=${join(dir, 'out')}`, '--json']);
    if (r.code !== 2) return `expected exit 2, got ${r.code}`;
    const status = r.json?.results?.[0]?.status;
    if (status !== 'no-baseline') return `expected status no-baseline, got ${status}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a size mismatch -> exit 2, says which sizes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-size-'));
  try {
    const a = writePng(join(dir, 'a.png'), frame());
    const big = new Uint8Array(48 * 32 * 4).fill(90);
    writeFileSync(join(dir, 'b.png'), encodePng(48, 32, big));
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${join(dir, 'b.png')}`, `--out=${join(dir, 'out')}`, '--json']);
    if (r.code !== 2) return `expected exit 2, got ${r.code}`;
    const res = r.json?.results?.[0];
    if (res?.baseline?.join('x') !== '96x64' || res?.candidate?.join('x') !== '48x32') {
      return `expected 96x64 vs 48x32, got ${JSON.stringify(res?.baseline)} vs ${JSON.stringify(res?.candidate)}`;
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('the diff PNG is written, decodable, and frame-sized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nona-diff-out-'));
  try {
    const a = writePng(join(dir, 'a.png'), frame());
    const b = writePng(join(dir, 'b.png'), frame({ rect: { x: 40, y: 20, w: 6, h: 6, c: [250, 250, 250] } }));
    const out = join(dir, 'out');
    const r = run(['--scenario=fixture', `--base=${a}`, `--new=${b}`, `--out=${out}`, '--json']);
    const p = join(out, 'fixture-diff.png');
    let dec;
    try {
      dec = decodePng(readFileSync(p));
    } catch (e) {
      return `expected a diff PNG at ${p}: ${e.message}`;
    }
    if (dec.width !== W || dec.height !== H) return `diff png is ${dec.width}x${dec.height}, expected ${W}x${H}`;
    /* Changed pixels are lit, so the rect must be brighter than a ghosted
       background pixel: that is what makes the image readable. */
    const lit = (20 * W + 42) * 4;
    const ghost = (2 * W + 2) * 4;
    if (dec.rgba[lit] <= dec.rgba[ghost]) return 'changed region is not lit relative to the ghosted background';
    if (r.code !== 1) return `expected exit 1 for a 6x6 change, got ${r.code}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('the decoder reproduces a committed baseline exactly', () => {
  /* The diff is only as trustworthy as the decode. Chromium was used once to
     establish this pixel value (see the PR); hard-coding it here turns that
     one-off check into a regression test that needs no browser and no GPU. */
  const dec = decodePng(readFileSync(resolve(ROOT, 'shots', 'overworld.png')));
  if (dec.width !== 1600 || dec.height !== 900) {
    return `overworld.png decoded as ${dec.width}x${dec.height}, expected 1600x900`;
  }
  const o = (360 * dec.width + 640) * 4;
  const px = [dec.rgba[o], dec.rgba[o + 1], dec.rgba[o + 2], dec.rgba[o + 3]];
  if (px.join(',') !== '35,42,45,255') {
    return `pixel (640,360) decoded as ${px.join(',')}, expected 35,42,45,255 (Chromium agrees)`;
  }
  return null;
});

/* --- run ---------------------------------------------------------------- */

let failed = 0;
for (const c of cases) {
  const problem = c.fn();
  if (problem) {
    failed++;
    console.log(`  ✗ ${c.name}\n      ${problem}`);
  } else {
    console.log(`  ✓ ${c.name}`);
  }
}

console.log('');
if (failed) {
  console.log(`diff.test: FAILED — ${failed} of ${cases.length} case(s) regressed\n`);
  process.exit(1);
}
console.log(`diff.test: OK — ${cases.length} cases`);
