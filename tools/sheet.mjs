#!/usr/bin/env node
/**
 * Contact sheet + histogram analysis for the critic loop.
 *
 *   node tools/sheet.mjs                 # tile shots/*.png into shots/_sheet.png
 *   node tools/sheet.mjs --analyze       # also print objective frame statistics
 *   node tools/sheet.mjs --analyze --no-fail   # report only; never exit non-zero
 *
 *   SHOTS=/tmp/frames node tools/sheet.mjs --analyze   # analyse another directory
 *
 * The analysis catches the failures a language model reviewing a PNG can miss:
 * lifted blacks, no true highlights, low contrast, oversaturation, dead frames.
 *
 * EXIT CODE. `--analyze` fails (exit 1) when a frame trips a HARD rule, and
 * names every rule it trips. Hard means the frame is not a rendered scene at
 * all -- nearly black, brighter than the art direction allows, or a palette so
 * flat it reads untextured. Everything else is ADVISORY: the frame is a scene
 * whose value range drifted (fog lifts the blacks, a spectacle frame clips).
 * Those print with an `advisory` tag and do not fail the run, because they are
 * judgement calls about the look, not evidence the renderer broke.
 *
 * Why the split, and not "any warning fails": the advisory rules are tuned to
 * a range, so a legitimate atmosphere pass can cross one without anything being
 * wrong. `overworld` sits 0.03 above the NO HIGHLIGHTS threshold in the
 * committed baselines; making that fatal would red `npm run check` for someone
 * who changed nothing. A gate that cries wolf on art is a gate people learn to
 * ignore, which is the failure this project already documents for hashes.
 *
 * `--no-fail` is the explicit opt-out. It prints exactly which hard failures it
 * suppressed and why the exit code is 0, so it can never look like a clean run.
 */
import { chromium } from 'playwright';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : resolve(ROOT, 'shots');
const analyze = process.argv.includes('--analyze');
const noFail = process.argv.includes('--no-fail');

/**
 * The rules, in one place so the severity is impossible to misread.
 *
 * `hard` = rendering failure or an instant-fail look from CRITIC_RUBRIC.md:
 * the frame is not a lit, textured, gothic scene. Order is presentation only.
 */
const RULES = [
  { hard: true, when: (s) => s.mean < 0.05, text: 'NEARLY BLACK — likely a rendering failure' },
  { hard: true, when: (s) => s.mean > 0.5, text: 'TOO BRIGHT for the Diablo look (target mean 0.16-0.34)' },
  { hard: true, when: (s) => s.colorBuckets < 90, text: 'FLAT PALETTE — too few distinct colors, reads untextured' },
  { hard: false, when: (s) => s.p01 > 0.06, text: 'LIFTED BLACKS — no true black, frame reads milky' },
  { hard: false, when: (s) => s.p99 < 0.72, text: 'NO HIGHLIGHTS — nothing bright, frame reads flat/dull' },
  { hard: false, when: (s) => s.stdev < 0.13, text: 'LOW CONTRAST — value range too compressed' },
  { hard: false, when: (s) => s.blownPct > 4, text: 'BLOWN OUT — bloom/exposure clipping too much of frame' },
  { hard: false, when: (s) => s.meanSat > 0.52, text: 'OVERSATURATED — not the desaturated gothic palette' },
];

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

let analysisExit = 0;
if (analyze) {
  const hardFailures = [];
  const advisories = [];
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

    const warn = RULES.filter((r) => r.when(stats));

    console.log(
      `  ${i.name.padEnd(11)} mean=${String(stats.mean).padEnd(6)} sd=${String(stats.stdev).padEnd(6)} ` +
      `p01=${String(stats.p01).padEnd(6)} p99=${String(stats.p99).padEnd(6)} ` +
      `blk%=${String(stats.trueBlackPct).padEnd(5)} sat=${String(stats.meanSat).padEnd(6)} colors=${stats.colorBuckets}`
    );
    for (const w of warn) {
      console.log(`      ⚠  ${w.text}${w.hard ? '' : '   [advisory]'}`);
      if (w.hard) hardFailures.push({ frame: i.name, text: w.text });
      else advisories.push({ frame: i.name, text: w.text });
    }
    if (!warn.length) console.log('      ✓  objective value/color metrics in AAA range');
  }
  console.log('');

  /* The exit path. This is the half that was missing: the detection above
     already worked, and the process reported success anyway. */
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (hardFailures.length) {
    console.log(
      `sheet: ${plural(hardFailures.length, 'hard failure')} across ${new Set(hardFailures.map((f) => f.frame)).size} frame(s)` +
      (advisories.length ? `, plus ${plural(advisories.length, 'advisory warning')} (ignored)` : '')
    );
    if (noFail) {
      console.log('       SUPPRESSED by --no-fail — exit 0 is an explicit opt-out, not a clean run:');
      for (const f of hardFailures) console.log(`         ${f.frame}: ${f.text}`);
    } else {
      console.log('       Run `--no-fail` only to inspect a known-bad frame; it prints what it suppressed.');
    }
  } else if (advisories.length) {
    console.log(`sheet: OK — no hard failures; ${plural(advisories.length, 'advisory warning')} printed above and not fatal.`);
  } else {
    console.log('sheet: OK — every frame is inside the hard rules.');
  }
  analysisExit = hardFailures.length && !noFail ? 1 : 0;
}

await browser.close();
console.log(`contact sheet -> shots/_sheet.png  (${imgs.length} frames)`);
process.exit(analysisExit);
