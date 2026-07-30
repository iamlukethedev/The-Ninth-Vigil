#!/usr/bin/env node
/**
 * Boot smoke test + determinism gate. Exits non-zero on failure, so CI can gate.
 *
 *   node tools/smoke.mjs                          # local, hardware GL
 *   node tools/smoke.mjs --software               # force SwiftShader (CI runners)
 *   node tools/smoke.mjs --pixels                 # also hash the canvas (needs a GPU)
 *   node tools/smoke.mjs --scenario=boss --frames=60
 *
 * `tools/debug.mjs` prints the same boot information but always exits 0, because
 * it exists for a human reading output. This one asserts instead:
 *
 *   1. the harness comes up and reports ready
 *   2. every module in the manifest loaded (nothing in `missing`)
 *   3. no uncaught page errors
 *   4. no shader link failure — the specific disaster mode of this renderer.
 *      Blowing the 16-sampler limit makes programs fail to LINK, and WebGL then
 *      draws those materials flat white, so the frame looks "bright" rather than
 *      broken and every value metric still lands in range
 *   5. two independent page loads of the same scenario, stepped the same number
 *      of frames, arrive at identical simulation state
 *
 * Check 5 is the one that protects the whole review loop: if the sim drifts, no
 * visual fix can be attributed to the change that supposedly made it.
 *
 * It hashes simulation state — actor positions, health, clock — rather than
 * pixels, for two reasons. Pixel capture needs Chromium's compositor, which
 * hangs indefinitely under SwiftShader on a GPU-less CI runner (measured: still
 * hung at 120 s having rendered the frame fine). And sim state is the stronger
 * test anyway: it is what `Math.random()` or a wall-clock read actually corrupts,
 * whereas a same-machine pixel hash mostly re-tests the GPU. `--pixels` adds the
 * canvas hash for local hardware runs.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const PORT = Number(args.port ?? 5186);
const SCENARIO = String(args.scenario ?? 'dungeon');
const FRAMES = Number(args.frames ?? 60);
const W = Number(args.w ?? 800);
const H = Number(args.h ?? 450);
const SOFTWARE = !!args.software || process.env.NONA_SOFTWARE_GL === '1';

/* Shader programs that fail to link surface through these; treat as fatal. */
const FATAL_CONSOLE = [
  'program not valid',
  'texture image units count exceeds',
  'Fragment shader is not compiled',
  'Vertex shader is not compiled',
  'INVALID_OPERATION: useProgram',
];

const portOpen = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.on('connect', () => (s.destroy(), res(true)));
  s.on('error', () => res(false));
  setTimeout(() => (s.destroy(), res(false)), 800);
});

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const proc = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore',
  });
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return proc;
  }
  proc.kill();
  throw new Error(`vite failed to start on port ${PORT}`);
}

/** One full boot -> scenario -> step -> capture cycle in a fresh page. */
async function run(browser, label) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const fatal = [];
  const errors = [];
  page.on('console', (m) => {
    const t = m.text();
    if (FATAL_CONSOLE.some((f) => t.includes(f))) fatal.push(t);
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`http://127.0.0.1:${PORT}/?shot=${SCENARIO}&headless=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__NONA__?.ready === true, null, { timeout: 300000 });

  const state = await page.evaluate(() => ({
    loaded: window.__NONA__.loaded ?? [],
    missing: window.__NONA__.missing ?? [],
    error: window.__NONA__.error ?? null,
  }));

  await page.evaluate(async (s) => { await window.__NONA__.scenario(s); }, SCENARIO);
  await page.evaluate(async (f) => { await window.__NONA__.step(f, 1 / 60); }, FRAMES);

  /* Simulation state, rounded to 4 dp. Rounding is deliberate: the AI and nav
     grid split work across frames against a `performance.now()` budget, so a
     slower machine can land mid-interpolation and differ in the last bits
     without the simulation having actually diverged. Real nondeterminism moves
     actors by centimetres or more, which survives the rounding easily. */
  const sim = await page.evaluate(() => {
    const e = window.engine;
    const r = (v) => +v.toFixed(4);
    const hero = e.get('hero');
    const best = e.get('bestiary');
    return {
      frame: e.clock?.frame ?? null,
      hero: hero?.position ? hero.position.toArray().map(r) : null,
      camera: e.camera.position.toArray().map(r),
      enemies: (best?.entities ?? []).map((en) => ({
        t: en.type ?? en.archetype ?? '?',
        p: (en.position ?? en.root?.position)?.toArray?.().map(r) ?? null,
        d: !!en.isDead,
        hp: typeof en.hp === 'number' ? r(en.hp) : null,
      })),
    };
  });
  const simHash = createHash('md5').update(JSON.stringify(sim)).digest('hex').slice(0, 12);

  let pxHash = null;
  if (args.pixels) {
    const png = await page.screenshot({ animations: 'disabled', timeout: 120000 });
    pxHash = createHash('md5').update(png).digest('hex').slice(0, 12);
  }

  const stats = await page.evaluate(() => window.__NONA__.stats?.() ?? null).catch(() => null);
  await page.close();

  console.log(
    `  ${label}: ${state.loaded.length} modules, ${sim.enemies.length} actors, ` +
    `sim ${simHash}${pxHash ? `, px ${pxHash}` : ''}${stats ? `, ${stats.frameMs} ms/frame` : ''}`
  );
  return { ...state, sim, simHash, pxHash, fatal, errors, stats };
}

const failures = [];
const server = await ensureServer();
const browser = await chromium.launch({
  args: SOFTWARE
    ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars']
    : ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--hide-scrollbars'],
});

console.log(`smoke: ${SCENARIO} @${FRAMES}f ${W}x${H}, ${SOFTWARE ? 'SwiftShader (software)' : 'hardware GL'}`);

try {
  const a = await run(browser, 'run 1');
  const b = await run(browser, 'run 2');

  if (a.error) failures.push(`harness reported an error: ${a.error}`);
  if (a.missing.length) failures.push(`modules failed to load: ${a.missing.join(', ')}`);
  if (!a.loaded.length) failures.push('no modules loaded at all');
  if (a.errors.length) failures.push(`uncaught page error(s): ${a.errors.slice(0, 3).join(' | ')}`);
  if (a.fatal.length) failures.push(`shader link failure(s): ${[...new Set(a.fatal)].slice(0, 3).join(' | ')}`);
  if (a.simHash !== b.simHash) {
    /* Name the field that moved — "it is nondeterministic" is not actionable. */
    const diffs = [];
    if (JSON.stringify(a.sim.hero) !== JSON.stringify(b.sim.hero)) diffs.push(`hero ${a.sim.hero} vs ${b.sim.hero}`);
    if (JSON.stringify(a.sim.camera) !== JSON.stringify(b.sim.camera)) diffs.push(`camera ${a.sim.camera} vs ${b.sim.camera}`);
    if (a.sim.frame !== b.sim.frame) diffs.push(`frame ${a.sim.frame} vs ${b.sim.frame}`);
    if (a.sim.enemies.length !== b.sim.enemies.length) diffs.push(`enemy count ${a.sim.enemies.length} vs ${b.sim.enemies.length}`);
    else {
      for (let i = 0; i < a.sim.enemies.length; i++) {
        const x = JSON.stringify(a.sim.enemies[i]), y = JSON.stringify(b.sim.enemies[i]);
        if (x !== y) { diffs.push(`enemy[${i}] ${x} vs ${y}`); break; }
      }
    }
    failures.push(`simulation is non-deterministic across two runs of '${SCENARIO}': ${diffs.join('; ') || 'state differs'}`);
  }
  if (args.pixels && a.pxHash !== b.pxHash) {
    failures.push(`canvas differs across two runs of '${SCENARIO}' (${a.pxHash} vs ${b.pxHash})`);
  }
} catch (e) {
  failures.push(`threw: ${e.message}`);
}

await browser.close();
if (server) server.kill();

if (failures.length) {
  console.log(`\nsmoke: FAILED\n`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\nsmoke: OK — boots, all modules load, shaders link, simulation is deterministic${args.pixels ? ', canvas is stable' : ''}`);
