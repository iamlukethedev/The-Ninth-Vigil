#!/usr/bin/env node
/** Boot the game headless and dump every console message + page error. */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 5187;
const scenario = (process.argv.find((a) => a.startsWith('--scenario=')) ?? '--scenario=combat').split('=')[1];
const frames = Number((process.argv.find((a) => a.startsWith('--frames=')) ?? '--frames=30').split('=')[1]);

const portOpen = (p) => new Promise((res) => {
  const s = net.connect(p, '127.0.0.1');
  s.on('connect', () => (s.destroy(), res(true)));
  s.on('error', () => res(false));
  setTimeout(() => (s.destroy(), res(false)), 800);
});

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn('node', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 120 && !(await portOpen(PORT)); i++) await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[PAGEERROR] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => console.log(`[REQFAIL] ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://127.0.0.1:${PORT}/?shot=${scenario}&headless=1`, { waitUntil: 'load', timeout: 60000 });
await new Promise((r) => setTimeout(r, 6000));

const state = await page.evaluate(() => ({
  hasHarness: !!window.__NONA__,
  ready: window.__NONA__?.ready,
  error: window.__NONA__?.error,
  loaded: window.__NONA__?.loaded,
  missing: window.__NONA__?.missing,
}));
console.log('STATE:', JSON.stringify(state, null, 2));

if (state.ready) {
  try {
    await page.evaluate(async (s) => { await window.__NONA__.scenario(s); }, scenario);
    await page.evaluate(async (f) => { await window.__NONA__.step(f, 1 / 60); }, frames);
    console.log('STATS:', JSON.stringify(await page.evaluate(() => window.__NONA__.stats()), null, 2));
  } catch (e) { console.log('RUN ERROR:', e.message); }
}

await browser.close();
if (server) server.kill();
