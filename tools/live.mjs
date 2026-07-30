#!/usr/bin/env node
/**
 * Capture the LIVE game exactly as a browser sees it — real rAF loop, no
 * scenario injection, no headless flag. This reproduces what the user gets at
 * http://localhost:<port>/ and is the only way to catch bugs that exist solely
 * in the un-posed default boot path.
 *
 *   node tools/live.mjs [--port=5190] [--url=...] [--wait=8] [--out=shots/_live.png]
 */
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const ROOT = resolve(import.meta.dirname, '..');
const port = arg('port', '5190');
const url = arg('url', `http://localhost:${port}/`);
const wait = Number(arg('wait', 8)) * 1000;
const out = resolve(ROOT, arg('out', 'shots/_live.png'));

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));

await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__NONA__?.ready === true, null, { timeout: 120000 });
await new Promise((r) => setTimeout(r, wait));

const state = await page.evaluate(() => {
  const e = window.engine;
  return {
    scenarioApplied: e?.scenario?.name ?? null,
    exposure: +(e?.renderer?.toneMappingExposure ?? 0).toFixed(3),
    fog: e?.scene?.fog
      ? { type: e.scene.fog.type ?? e.scene.fog.constructor?.name, color: '#' + e.scene.fog.color.getHexString(), density: e.scene.fog.density, near: e.scene.fog.near, far: e.scene.fog.far }
      : null,
    background: e?.scene?.background?.isColor ? '#' + e.scene.background.getHexString() : (e?.scene?.background ? 'texture' : null),
    envSet: !!e?.scene?.environment,
    camera: {
      pos: e?.camera?.position?.toArray().map((v) => +v.toFixed(2)),
      fov: e?.camera?.fov,
    },
    hero: e?.get?.('hero')?.position?.toArray?.().map((v) => +v.toFixed(2)) ?? null,
    loaded: window.__NONA__?.loaded,
    missing: window.__NONA__?.missing,
    stats: window.__NONA__?.stats?.() ?? null,
  };
});

mkdirSync(resolve(ROOT, 'shots'), { recursive: true });
await page.screenshot({ path: out });
console.log('LIVE STATE:', JSON.stringify(state, null, 2));
if (problems.length) {
  // Collapse by pattern — 2000 copies of one warning is one bug, not 2000.
  const groups = new Map();
  for (const p of problems) {
    const key = p.replace(/\d+(\.\d+)?/g, 'N').slice(0, 200);
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log(`\n${problems.length} console problem(s), ${groups.size} distinct:`);
  for (const [k, n] of [...groups].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}x  ${k}`);
  }
}
console.log(`\nlive frame -> ${out.replace(ROOT + '/', '')}`);
await browser.close();
