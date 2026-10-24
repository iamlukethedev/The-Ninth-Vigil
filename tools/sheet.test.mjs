#!/usr/bin/env node
/**
 * Sheet analysis self-test — proves `sheet.mjs --analyze` gates on a real
 * warning instead of printing one and exiting 0.
 *
 *   node tools/sheet.test.mjs
 *
 * WHY THIS EXISTS. The analyser detected lifted blacks, a flat palette and an
 * over-bright frame, printed all three, and reported success. `npm run check`
 * is described as the thing to run before pushing, so that run was a green
 * light over a frame it had just called broken. The detection half was never
 * the problem; the exit path was missing — and nothing tested it.
 *
 * Fixtures are built in a TEMP dir and handed to the tool through `SHOTS`, so
 * the real baselines in `shots/` are never overwritten by a test that then
 * asserts on them. One case copies a committed baseline in deliberately: it is
 * the "does this still pass on the frames the project actually ships" check,
 * and it is the reason the hard/advisory split exists.
 *
 * Exit 0 = every case behaves as specified. Exit 1 = a case regressed.
 */
import { chromium } from 'playwright';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SHEET = join(ROOT, 'tools', 'sheet.mjs');
const W = 320;
const H = 180;

/* --- fixtures ----------------------------------------------------------- */

/**
 * Paint one frame into a canvas and screenshot it.
 *
 * Screenshot rather than a hand-rolled PNG encoder: the test must not need a
 * decoder it does not have, and a solid fill is exactly the "single-colour
 * frame" CRITIC_RUBRIC.md calls an instant fail.
 */
async function makeFrame(browser, dir, name, mode) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#000">` +
    `<canvas id="c" width="${W}" height="${H}" style="display:block"></canvas></body></html>`
  );
  await page.evaluate(({ mode, W, H }) => {
    const c = document.getElementById('c');
    const x = c.getContext('2d');
    if (mode === 'flat') {
      x.fillStyle = '#c8c8c8';
      x.fillRect(0, 0, W, H);
      return;
    }
    /* A dim, low-highlight, slightly milky ramp: a *scene* whose value range
       drifted, which is what the advisory rules describe. It must stay below
       every hard threshold -- mean ~0.33, and enough distinct colour buckets to
       clear FLAT PALETTE, which is why each channel gets its own noise. */
    const img = x.createImageData(W, H);
    const clamp = (v) => Math.max(0, Math.min(1, v));
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    for (let y = 0; y < H; y++) {
      for (let px = 0; px < W; px++) {
        const v = clamp(0.06 + (px / (W - 1)) * 0.54 + rand() * 0.04);
        const u = y / (H - 1) - 0.5;
        const o = (y * W + px) * 4;
        img.data[o] = clamp(v * (1 + 0.45 * u) + rand() * 0.05) * 255;
        img.data[o + 1] = clamp(v + rand() * 0.05) * 255;
        img.data[o + 2] = clamp(v * (1 - 0.45 * u) + rand() * 0.05) * 255;
        img.data[o + 3] = 255;
      }
    }
    x.putImageData(img, 0, 0);
  }, { mode, W, H });
  const path = join(dir, `${name}.png`);
  await page.screenshot({ path });
  await page.close();
  return path;
}

function shotsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'nona-sheet-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run the real analyser against SHOTS=dir and return its exit code + output. */
function runSheet(dir, args = ['--analyze']) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [SHEET, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, SHOTS: dir },
    });
  } catch (e) {
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    code = e.status ?? 1;
  }
  return { code, out };
}

/* --- cases -------------------------------------------------------------- */

const cases = [];
const testCase = (name, fn) => cases.push({ name, fn });

testCase('a flat grey frame fails the run (exit 1) and names the rules', async (browser) => {
  const dir = shotsDir();
  try {
    await makeFrame(browser, dir, 'flat', 'flat');
    const r = runSheet(dir);
    if (r.code !== 1) return `expected exit 1, got ${r.code}\n${r.out}`;
    for (const rule of ['FLAT PALETTE', 'TOO BRIGHT']) {
      if (!r.out.includes(rule)) return `${rule} was not reported\n${r.out}`;
    }
    if (!/hard failure/.test(r.out)) return `no hard-failure summary line\n${r.out}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('--no-fail exits 0 but prints exactly what it suppressed', async (browser) => {
  const dir = shotsDir();
  try {
    await makeFrame(browser, dir, 'flat', 'flat');
    const r = runSheet(dir, ['--analyze', '--no-fail']);
    if (r.code !== 0) return `expected exit 0 with --no-fail, got ${r.code}\n${r.out}`;
    if (!r.out.includes('SUPPRESSED by --no-fail')) return `suppression was not announced\n${r.out}`;
    if (!r.out.includes('FLAT PALETTE')) return `suppressed rule was not named\n${r.out}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a committed baseline still passes (exit 0)', async (browser) => {
  const dir = shotsDir();
  try {
    copyFileSync(join(ROOT, 'shots', 'combat.png'), join(dir, 'combat.png'));
    const r = runSheet(dir);
    if (r.code !== 0) return `a shipped baseline must not fail, got exit ${r.code}\n${r.out}`;
    if (!r.out.includes('sheet: OK')) return `no OK summary\n${r.out}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('advisory warnings print but do not fail the run', async (browser) => {
  const dir = shotsDir();
  try {
    await makeFrame(browser, dir, 'dusk', 'ramp');
    const r = runSheet(dir);
    if (r.code !== 0) return `advisory-only frame must exit 0, got ${r.code}\n${r.out}`;
    if (!r.out.includes('[advisory]')) return `expected at least one advisory warning\n${r.out}`;
    if (!/no hard failures/.test(r.out)) return `summary did not separate advisory from hard\n${r.out}`;
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --- run ---------------------------------------------------------------- */

const browser = await chromium.launch();
let failed = 0;
let passed = 0;
for (const c of cases) {
  let problem;
  try {
    problem = await c.fn(browser);
  } catch (e) {
    problem = `threw: ${e.message}`;
  }
  if (problem) {
    failed++;
    console.log(`  ✗ ${c.name}\n      ${problem.split('\n').join('\n      ')}`);
  } else {
    passed++;
    console.log(`  ✓ ${c.name}`);
  }
}
await browser.close();

console.log('');
if (failed) {
  console.log(`sheet.test: FAILED — ${failed} of ${cases.length} case(s) regressed\n`);
  process.exit(1);
}
console.log(`sheet.test: OK — ${passed} cases`);
