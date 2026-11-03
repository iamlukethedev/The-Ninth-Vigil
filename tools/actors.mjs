#!/usr/bin/env node
/**
 * Actor visibility audit. Answers the only question that matters when a player
 * says "I can't see my character": is it NOT DRAWING, or is it drawing with no
 * value separation from the ground behind it?
 *
 * For the hero and every enemy it reports: world pos, projected screen pixel,
 * whether any mesh is actually visible/in-frustum, and — decisively — the
 * rendered pixel luma AT the actor versus the floor ~40px away. A separation
 * under ~0.05 means it is drawing but invisible to a human.
 *
 *   node tools/actors.mjs [--port=5190] [--scenario=]
 */
import { chromium } from 'playwright';
import { join } from 'node:path';
import { ensureRepoDir } from './paths.mjs';

const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const port = arg('port', '5190');
const scenario = arg('scenario', '');
const url = `http://127.0.0.1:${port}/${scenario ? `?shot=${scenario}` : ''}`;

const W = 1600, H = 900;
// shots/_debug/ is gitignored, so a fresh clone does not have it. Created here,
// like crop/shot/live do, and anchored to the repo root: the write used to be a
// cwd-relative 'shots/_debug/actors.png', so running this from anywhere but the
// repo root scattered the file into whatever directory you happened to be in.
const SHOT = join(ensureRepoDir('shots/_debug'), 'actors.png');
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__NONA__?.ready === true, null, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 7000));

const actors = await page.evaluate((dims) => {
  const e = window.engine;
  const cam = e.camera;
  cam.updateMatrixWorld(true);
  const V = e.camera.position.constructor;

  const proj = (v) => {
    const q = v.clone().project(cam);
    return {
      px: [Math.round((q.x * 0.5 + 0.5) * dims.W), Math.round((-q.y * 0.5 + 0.5) * dims.H)],
      inFrame: q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1 && q.z >= -1 && q.z <= 1,
    };
  };

  const meshInfo = (root) => {
    let n = 0, visible = 0, tris = 0, minY = 1e9, maxY = -1e9;
    root?.traverse?.((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      n++;
      let vis = o.visible, p = o.parent;
      while (vis && p) { vis = p.visible; p = p.parent; }
      if (vis && o.material?.visible !== false) visible++;
      const g = o.geometry;
      if (g) {
        tris += g.index ? g.index.count / 3 : (g.attributes?.position?.count ?? 0) / 3;
        if (!g.boundingBox) g.computeBoundingBox?.();
        if (g.boundingBox) { minY = Math.min(minY, g.boundingBox.min.y); maxY = Math.max(maxY, g.boundingBox.max.y); }
      }
    });
    return { meshes: n, visibleMeshes: visible, tris: Math.round(tris), localY: [+minY.toFixed(2), +maxY.toFixed(2)] };
  };

  const out = [];
  const hero = e.get('hero');
  if (hero) {
    const p = hero.position.clone();
    const head = p.clone(); head.y += 1.6;
    out.push({ kind: 'HERO', type: 'hero', pos: p.toArray().map((v) => +v.toFixed(2)),
      feet: proj(p), head: proj(head), ...meshInfo(hero.root ?? hero.group) });
  }
  const best = e.get('bestiary');
  for (const en of (best?.entities ?? []).slice(0, 12)) {
    const p = (en.position ?? en.root?.position)?.clone?.();
    if (!p) continue;
    const head = p.clone(); head.y += 1.6;
    out.push({ kind: 'ENEMY', type: en.type ?? en.archetype ?? '?', dead: !!en.isDead,
      pos: p.toArray().map((v) => +v.toFixed(2)), feet: proj(p), head: proj(head),
      ...meshInfo(en.root ?? en.group ?? en.mesh) });
  }
  return { actors: out, camPos: cam.position.toArray().map((v) => +v.toFixed(2)),
           scenario: e.scenario?.name ?? null };
}, { W, H });

// Screenshot once, then sample luma at each actor vs the floor beside it.
const shot = await page.screenshot({ path: SHOT });
const b64 = shot.toString('base64');
const samples = await page.evaluate(async ({ b64, actors, W, H }) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data;
  const lumaAt = (x, y, r = 3) => {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const px = Math.max(0, Math.min(img.width - 1, x + dx));
      const py = Math.max(0, Math.min(img.height - 1, y + dy));
      const i = (py * img.width + px) * 4;
      s += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      n++;
    }
    return +(s / n).toFixed(3);
  };
  return actors.map((a) => {
    const mid = [Math.round((a.feet.px[0] + a.head.px[0]) / 2), Math.round((a.feet.px[1] + a.head.px[1]) / 2)];
    const body = lumaAt(mid[0], mid[1]);
    const bgL = lumaAt(Math.max(0, mid[0] - 55), mid[1]);
    const bgR = lumaAt(Math.min(W - 1, mid[0] + 55), mid[1]);
    const bg = +((bgL + bgR) / 2).toFixed(3);
    return { kind: a.kind, type: a.type, mid, bodyLuma: body, floorLuma: bg,
             separation: +Math.abs(body - bg).toFixed(3), heightPx: Math.abs(a.feet.px[1] - a.head.px[1]) };
  });
}, { b64, actors: actors.actors, W, H });

console.log(`scenario=${actors.scenario}  camera=${actors.camPos}\n`);
console.log('kind   type        worldPos              headPx      feetPx    inFrame  meshes vis  tris   hPx  bodyL floorL  SEP');
actors.actors.forEach((a, i) => {
  const s = samples[i] ?? {};
  console.log(
    `${a.kind.padEnd(6)} ${String(a.type).padEnd(11)} ${String(a.pos).padEnd(21)} ` +
    `${String(a.head.px).padEnd(11)} ${String(a.feet.px).padEnd(9)} ${String(a.feet.inFrame).padEnd(8)} ` +
    `${String(a.meshes).padEnd(6)} ${String(a.visibleMeshes).padEnd(4)} ${String(a.tris).padEnd(6)} ` +
    `${String(s.heightPx ?? '-').padEnd(4)} ${String(s.bodyLuma ?? '-').padEnd(5)} ${String(s.floorLuma ?? '-').padEnd(6)} ${s.separation ?? '-'}`
  );
});
console.log(`
INTERPRETATION
  visibleMeshes = 0            -> NOT DRAWING (a bug: culled, hidden, or never built)
  inFrame = false              -> off-camera (spawn/placement bug)
  hPx < 25                     -> too small to read at this camera distance
  SEP < 0.05                   -> drawing, but no value separation from the floor: invisible to a human
  SEP > 0.15 and hPx > 40      -> should be clearly visible; if the player still cannot see it, it is a
                                  silhouette/shape-legibility problem, not a contrast problem`);
await browser.close();
