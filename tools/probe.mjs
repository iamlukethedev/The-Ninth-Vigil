#!/usr/bin/env node
/**
 * Inspect live scene-graph state for a specific object. Answers "is it actually
 * on screen and visible?" — which a screenshot alone cannot distinguish from
 * "it is somewhere else" or "it is invisible".
 *
 *   node tools/probe.mjs [--port=5190]
 */
import { chromium } from 'playwright';

const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const port = arg('port', '5190');

const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__NONA__?.ready === true, null, { timeout: 120000 });
await new Promise((r) => setTimeout(r, 8000));

const out = await page.evaluate(() => {
  const THREE = window.engine?.constructor ? null : null;
  const e = window.engine;
  const hero = e.get('hero');
  const cam = e.camera;
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();

  const project = (v) => {
    const p = v.clone().applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (p.w !== undefined && p.w !== 0) { /* Vector3 has no w; use project() */ }
    const q = v.clone().project(cam);
    return {
      ndc: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3)],
      px: [Math.round((q.x * 0.5 + 0.5) * 1600), Math.round((-q.y * 0.5 + 0.5) * 900)],
      onScreen: q.x >= -1 && q.x <= 1 && q.y >= -1 && q.y <= 1 && q.z >= -1 && q.z <= 1,
    };
  };

  const walk = (obj, depth = 0, acc = []) => {
    acc.push({
      name: obj.name || obj.type,
      type: obj.type,
      visible: obj.visible,
      depth,
      tris: obj.geometry?.index
        ? obj.geometry.index.count / 3
        : obj.geometry?.attributes?.position
        ? obj.geometry.attributes.position.count / 3
        : 0,
      mat: obj.material
        ? (Array.isArray(obj.material) ? obj.material.map((m) => m.name || m.type).join('|') : obj.material.name || obj.material.type)
        : null,
      matVisible: obj.material && !Array.isArray(obj.material)
        ? { transparent: obj.material.transparent, opacity: obj.material.opacity, visible: obj.material.visible, depthWrite: obj.material.depthWrite, side: obj.material.side }
        : null,
      frustumCulled: obj.frustumCulled,
      wpos: obj.getWorldPosition(new obj.position.constructor()).toArray().map((v) => +v.toFixed(2)),
      scale: obj.scale.toArray().map((v) => +v.toFixed(3)),
    });
    for (const c of obj.children) if (depth < 3) walk(c, depth + 1, acc);
    return acc;
  };

  const heroRoot = hero?.root ?? hero?.group ?? null;
  const heroPos = hero?.position?.clone?.() ?? null;

  // Any ancestor invisible?
  let chainHidden = null;
  if (heroRoot) {
    let o = heroRoot, chain = [];
    while (o) { chain.push(`${o.name || o.type}:${o.visible}`); o = o.parent; }
    chainHidden = chain.join(' <- ');
  }

  return {
    heroPos: heroPos?.toArray().map((v) => +v.toFixed(2)),
    heroProjected: heroPos ? project(heroPos) : null,
    heroRootPresent: !!heroRoot,
    heroRootInScene: heroRoot ? !!heroRoot.parent : false,
    visibilityChain: chainHidden,
    heroTree: heroRoot ? walk(heroRoot) : null,
    cameraPos: cam.position.toArray().map((v) => +v.toFixed(2)),
    cameraTarget: e.get('camera')?.focus?.toArray?.().map((v) => +v.toFixed(2)) ?? null,
    heroKeys: hero ? Object.keys(hero).slice(0, 40) : null,
  };
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
