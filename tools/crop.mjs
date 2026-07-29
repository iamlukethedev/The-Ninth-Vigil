#!/usr/bin/env node
/**
 * Crop and upscale a region of a captured PNG so fine detail can actually be
 * judged. A 1600x900 frame shown whole hides exactly the flaws that matter —
 * material grain, edge bevels, contact shadows, aliasing, silhouette read.
 *
 *   node tools/crop.mjs --in=shots/combat.png --x=0.5 --y=0.5 --w=0.25 --scale=3
 *   node tools/crop.mjs --in=shots/closeup.png --x=0.5 --y=0.55 --w=0.3 --out=shots/_debug/z.png
 *
 * x/y are the CENTRE of the crop as a fraction of image size; w is the crop
 * width as a fraction (height follows the source aspect unless --h is given).
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.split('=').slice(1).join('=') : d;
};
const ROOT = resolve(import.meta.dirname, '..');
const inPath = resolve(ROOT, arg('in', 'shots/combat.png'));
const outPath = resolve(ROOT, arg('out', 'shots/_debug/crop.png'));
const cx = Number(arg('x', 0.5));
const cy = Number(arg('y', 0.5));
const cw = Number(arg('w', 0.25));
const chArg = arg('h', null);
const scale = Number(arg('scale', 3));

const data = 'data:image/png;base64,' + readFileSync(inPath).toString('base64');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const box = await page.evaluate(
  async ({ data, cx, cy, cw, chArg, scale }) => {
    const img = new Image();
    img.src = data;
    await img.decode();
    const ch = chArg !== null ? Number(chArg) : cw * (img.width / img.height);
    const sw = Math.max(1, Math.round(img.width * cw));
    const sh = Math.max(1, Math.round(img.height * ch));
    const sx = Math.round(img.width * cx - sw / 2);
    const sy = Math.round(img.height * cy - sh / 2);
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false; // nearest-neighbour: show the real pixels
    g.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    document.body.style.margin = '0';
    document.body.appendChild(c);
    return { src: [img.width, img.height], crop: [sx, sy, sw, sh], out: [c.width, c.height] };
  },
  { data, cx, cy, cw, chArg, scale }
);

await page.setViewportSize({ width: box.out[0], height: box.out[1] });
mkdirSync(dirname(outPath), { recursive: true });
await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: box.out[0], height: box.out[1] } });
console.log(
  `${inPath.replace(ROOT + '/', '')} ${box.src.join('x')} -> crop ${box.crop.join(',')} @${scale}x -> ${outPath.replace(ROOT + '/', '')} ${box.out.join('x')}`
);
await browser.close();
