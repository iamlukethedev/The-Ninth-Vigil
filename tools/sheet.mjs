#!/usr/bin/env node
/**
 * Contact sheet + histogram analysis for the critic loop.
 *
 *   node tools/sheet.mjs                 # tile shots/*.png into shots/_sheet.png
 *   node tools/sheet.mjs --analyze       # also print objective frame statistics
 *
 * The analysis catches the failures a language model reviewing a PNG can miss:
 * lifted blacks, no true highlights, low contrast, oversaturation, dead frames.
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = resolve(ROOT, 'shots');
const analyze = process.argv.includes('--analyze');

const files = readdirSync(SHOTS)
  .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
  .sort();

if (!files.length) {
  console.log('no shots found — run: node tools/shot.mjs --all');
  process.exit(1);
}

const imgs = files.map((f) => ({
  name: basename(f, '.png'),
  data: 'data:image/png;base64,' + readFileSync(resolve(SHOTS, f)).toString('base64'),
}));

const cols = Math.min(3, imgs.length);
const cellW = 640;
const cellH = 360;
const rows = Math.ceil(imgs.length / cols);

const html = `<!doctype html><html><body style="margin:0;background:#0a0a0c">
<div style="display:grid;grid-template-columns:repeat(${cols},${cellW}px);gap:2px;width:max-content">
${imgs
  .map(
    (i) => `<div style="position:relative;width:${cellW}px;height:${cellH}px;overflow:hidden">
  <img src="${i.data}" style="width:100%;height:100%;object-fit:cover;display:block">
  <div style="position:absolute;left:0;bottom:0;background:rgba(0,0,0,.72);color:#e8c88a;
    font:11px/1.9 monospace;padding:0 10px;letter-spacing:.16em">${i.name.toUpperCase()}</div>
</div>`
  )
  .join('\n')}
</div></body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: cols * cellW + (cols - 1) * 2, height: rows * cellH + (rows - 1) * 2 },
});
await page.setContent(html, { waitUntil: 'load' });
mkdirSync(SHOTS, { recursive: true });
await page.screenshot({ path: resolve(SHOTS, '_sheet.png') });

if (analyze) {
  console.log('\nFRAME ANALYSIS (objective — catches what the eye rationalizes away)\n');
  for (const i of imgs) {
    const stats = await page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, img.width, img.height).data;
      const hist = new Array(32).fill(0);
      let sum = 0, n = 0, satSum = 0, dark = 0, blown = 0;
      let uniq = new Set();
      for (let p = 0; p < d.length; p += 16) {
        const r = d[p] / 255, g = d[p + 1] / 255, b = d[p + 2] / 255;
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        satSum += mx === 0 ? 0 : (mx - mn) / mx;
        hist[Math.min(31, (l * 32) | 0)]++;
        sum += l; n++;
        if (l < 0.02) dark++;
        if (l > 0.96) blown++;
        if (n % 37 === 0) uniq.add((d[p] >> 4) + ',' + (d[p + 1] >> 4) + ',' + (d[p + 2] >> 4));
      }
      const mean = sum / n;
      let varSum = 0;
      for (let k = 0; k < 32; k++) varSum += hist[k] * Math.pow(k / 32 - mean, 2);
      const p = (frac) => {
        let acc = 0;
        for (let k = 0; k < 32; k++) { acc += hist[k]; if (acc / n >= frac) return k / 32; }
        return 1;
      };
      return {
        mean: +mean.toFixed(3),
        stdev: +Math.sqrt(varSum / n).toFixed(3),
        p01: +p(0.01).toFixed(3), p50: +p(0.5).toFixed(3), p99: +p(0.99).toFixed(3),
        trueBlackPct: +((dark / n) * 100).toFixed(1),
        blownPct: +((blown / n) * 100).toFixed(2),
        meanSat: +(satSum / n).toFixed(3),
        colorBuckets: uniq.size,
      };
    }, i.data);

    const warn = [];
    if (stats.p01 > 0.06) warn.push('LIFTED BLACKS — no true black, frame reads milky');
    if (stats.p99 < 0.72) warn.push('NO HIGHLIGHTS — nothing bright, frame reads flat/dull');
    if (stats.stdev < 0.13) warn.push('LOW CONTRAST — value range too compressed');
    if (stats.mean > 0.5) warn.push('TOO BRIGHT for the Diablo look (target mean 0.16-0.34)');
    if (stats.mean < 0.05) warn.push('NEARLY BLACK — likely a rendering failure');
    if (stats.blownPct > 4) warn.push('BLOWN OUT — bloom/exposure clipping too much of frame');
    if (stats.meanSat > 0.52) warn.push('OVERSATURATED — not the desaturated gothic palette');
    if (stats.colorBuckets < 90) warn.push('FLAT PALETTE — too few distinct colors, reads untextured');

    console.log(
      `  ${i.name.padEnd(11)} mean=${String(stats.mean).padEnd(6)} sd=${String(stats.stdev).padEnd(6)} ` +
      `p01=${String(stats.p01).padEnd(6)} p99=${String(stats.p99).padEnd(6)} ` +
      `blk%=${String(stats.trueBlackPct).padEnd(5)} sat=${String(stats.meanSat).padEnd(6)} colors=${stats.colorBuckets}`
    );
    for (const w of warn) console.log(`      ⚠  ${w}`);
    if (!warn.length) console.log('      ✓  objective value/color metrics in AAA range');
  }
  console.log('');
}

await browser.close();
console.log(`contact sheet -> shots/_sheet.png  (${imgs.length} frames)`);
