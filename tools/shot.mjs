#!/usr/bin/env node
/**
 * Deterministic headless screenshot harness.
 *
 *   node tools/shot.mjs --scenario=combat --out=shots/combat.png [--w=1920] [--h=1080] [--frames=240]
 *   node tools/shot.mjs --all
 *
 * Boots the vite dev server (reusing one if already listening), loads the game
 * with ?shot=<scenario>, waits for window.__NONA__.ready, drives the sim a
 * fixed number of frames with a fixed dt so output is byte-stable, then grabs a
 * PNG of the canvas.
 *
 * Also prints any console errors / WebGL warnings so critics see breakage.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 5187;
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);

const SCENARIOS = {
  hub: { frames: 90, desc: 'Town hub / safe zone, wide establishing shot' },
  dungeon: { frames: 90, desc: 'Interior crypt corridor, torchlit' },
  combat: { frames: 180, desc: 'Mid-fight with a pack of enemies, VFX active' },
  boss: { frames: 240, desc: 'Boss encounter, full spectacle' },
  overworld: { frames: 120, desc: 'Open exterior, weather + fog + vista' },
  inventory: { frames: 60, desc: 'Inventory + character sheet UI' },
  closeup: { frames: 60, desc: 'Hero close-up, material/armor detail' },
  night: { frames: 120, desc: 'Night exterior, moonlight + emissive sources' },
};

function portOpen(port) {
  return new Promise((res) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    setTimeout(() => (s.destroy(), res(false)), 800);
  });
}

async function ensureServer() {
  if (await portOpen(PORT)) return null;
  const proc = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    detached: false,
  });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) return proc;
  }
  proc.kill();
  throw new Error('vite failed to start on port ' + PORT);
}

async function shoot(browser, scenario, outPath, w, h, frames) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
  });
  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

  await page.goto(`http://127.0.0.1:${PORT}/?shot=${scenario}&headless=1`, {
    waitUntil: 'load',
    timeout: 60000,
  });

  await page.waitForFunction(() => window.__NONA__ && window.__NONA__.ready === true, null, {
    timeout: 120000,
  });

  // Let the engine build the scenario (assets, streaming, GPU warmup).
  await page.evaluate(async (s) => {
    if (window.__NONA__.scenario) await window.__NONA__.scenario(s);
  }, scenario);

  // Deterministic warm-up then the measured frames.
  await page.evaluate(async (f) => {
    await window.__NONA__.step(f, 1 / 60);
  }, frames);

  mkdirSync(dirname(outPath), { recursive: true });
  const canvas = await page.$('canvas');
  await (canvas ?? page).screenshot({ path: outPath });

  const perf = await page
    .evaluate(() => window.__NONA__.stats?.() ?? null)
    .catch(() => null);

  await page.close();
  return { problems, perf };
}

const w = Number(args.w ?? 1920);
const h = Number(args.h ?? 1080);
const server = await ensureServer();
/* ANGLE backend is selected per platform, because a hardcoded backend silently
   degrades the capture instead of failing it.

   Measured on Linux (Ubuntu, headless Chromium, NVIDIA GTX):
     --use-angle=metal     -> ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))   SOFTWARE
     --use-angle=vulkan    -> ANGLE (NVIDIA, Vulkan 1.4.312 (NVIDIA GeForce))    hardware
     --use-angle=gl        -> ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX)     hardware
     no --use-angle at all -> ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))   SOFTWARE

   Two things follow. `metal` is macOS-only, so on Linux our old hardcoded value
   did not error — it fell through to SwiftShader and every capture came back
   software-rendered, which is the exact configuration the README warns hangs
   the compositor. And headless Chromium defaults to SwiftShader unless a
   backend is requested explicitly, so "just drop the flag" is not the fix
   either.

   NONA_ANGLE overrides (e.g. NONA_ANGLE=swiftshader to force a deterministic
   software run). The resolved backend and the renderer Chromium actually got
   are printed once below, so a capture never silently claims hardware it did
   not use. */
const ANGLE =
  process.env.NONA_ANGLE ??
  (process.platform === 'darwin' ? 'metal' : process.platform === 'win32' ? 'd3d11' : 'vulkan');

const browser = await chromium.launch({
  args: [
    `--use-angle=${ANGLE}`,
    ...(ANGLE === 'swiftshader' ? ['--enable-unsafe-swiftshader'] : []),
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--hide-scrollbars',
  ],
});

{
  const probe = await browser.newPage();
  const renderer = await probe
    .evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return 'no webgl2 context';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })
    .catch((e) => `probe failed: ${e.message.split('\n')[0]}`);
  await probe.close();
  console.log(`angle: ${ANGLE} (${process.platform}) -> ${renderer}`);
}

const list = args.all ? Object.keys(SCENARIOS) : [String(args.scenario ?? 'combat')];
let failed = false;
for (const s of list) {
  const out = resolve(ROOT, String(args.out ?? `shots/${s}.png`));
  const frames = Number(args.frames ?? SCENARIOS[s]?.frames ?? 120);
  try {
    const { problems, perf } = await shoot(browser, s, out, w, h, frames);
    console.log(`OK  ${s.padEnd(10)} -> ${out.replace(ROOT + '/', '')}  ${w}x${h} @${frames}f`);
    if (perf) console.log(`    perf: ${JSON.stringify(perf)}`);
    if (problems.length) {
      console.log(`    ${problems.length} console problem(s):`);
      for (const p of problems.slice(0, 12)) console.log(`      ${p}`);
    }
  } catch (e) {
    failed = true;
    console.log(`ERR ${s}: ${e.message}`);
  }
}

await browser.close();
if (server) server.kill();
process.exit(failed ? 1 : 0);
