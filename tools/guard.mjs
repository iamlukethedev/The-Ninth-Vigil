#!/usr/bin/env node
/**
 * Convention guard — the entry point.
 *
 *   node tools/guard.mjs
 *
 * The RULES live in `tools/guard-rules.mjs`, which `tools/guard.test.mjs`
 * imports. That split is deliberate, and it is what makes this file safe:
 * `guard.mjs` ALWAYS runs when invoked — it holds no direct-run check — so
 * there is no path where the detection misfires into "start, do nothing, exit
 * 0". The failure mode of a self-referential `import.meta.url` check is
 * silence, and CI reads silence as a pass.
 *
 * Everything here is I/O and exit codes; everything pure is in guard-rules.mjs.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RULES, HTML_RULES, normalizeRel, scanHtml, scanSource,
} from './guard-rules.mjs';

/* fileURLToPath, not URL.pathname — the latter percent-encodes, so any checkout
   with a space in its path scans a directory that does not exist. */
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'shots']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(e)) && !e.endsWith('.tmp.mjs')) out.push(p);
  }
  return out;
}

/* Every HTML file in the repository, not just the entry point. */
function walkHtml(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkHtml(p, out);
    else if (extname(e).toLowerCase() === '.html') out.push(p);
  }
  return out;
}

/**
 * Run the scan and report. Exported so `guard.test.mjs` can drive the real
 * scan against a fixture rather than a copy of it.
 */
export function runGuard({ root = ROOT } = {}) {
  const files = walk(root);
  const htmlFiles = walkHtml(root);
  const failures = [];

  /* --- 1. every file must parse --- */
  for (const p of files) {
    try {
      execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
    } catch (e) {
      failures.push({ id: 'syntax', file: normalizeRel(relative(root, p)), line: 0, text: String(e.stderr).split('\n')[1] ?? 'parse error', why: 'File does not parse.' });
    }
  }

  /* --- 2. convention rules, comments stripped --- */
  for (const p of files) {
    /* The path goes in NORMALISED, so the scope below is one convention on
       every platform; the rules themselves are applied by scanSource, which is
       also what the self-test drives. */
    scanSource(relative(root, p), readFileSync(p, 'utf8'), failures);
  }

  /* --- 2b. HTML entry points, scanned separately --- */
  for (const p of htmlFiles) {
    const rel = normalizeRel(relative(root, p));
    scanHtml(readFileSync(p, 'utf8'), rel, failures);
  }

  /* --- 3. dependency allowlist --- */
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const ALLOWED_RUNTIME = new Set(['three']);
  const ALLOWED_DEV = new Set(['vite', 'playwright']);
  for (const d of Object.keys(pkg.dependencies ?? {})) {
    if (!ALLOWED_RUNTIME.has(d)) {
      failures.push({ id: 'no-new-deps', file: 'package.json', line: 0, text: d, why: 'No new runtime dependencies. three only.' });
    }
  }
  for (const d of Object.keys(pkg.devDependencies ?? {})) {
    if (!ALLOWED_DEV.has(d)) {
      failures.push({ id: 'no-new-deps', file: 'package.json', line: 0, text: d, why: 'No new dev dependencies. vite and playwright only.' });
    }
  }

  return { ok: failures.length === 0, files: files.length, html: htmlFiles.length, rules: RULES.length + HTML_RULES.length + 2, violations: failures };
}

const report = runGuard();

/* --- report --- */
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.violations.length ? 1 : 0);
}

if (!report.violations.length) {
  console.log(`guard: OK — ${report.files} files, ${report.html} html, ${report.rules} rules, 0 violations`);
  process.exit(0);
}

const byRule = new Map();
for (const f of report.violations) {
  if (!byRule.has(f.id)) byRule.set(f.id, []);
  byRule.get(f.id).push(f);
}
console.log(`guard: ${report.violations.length} violation(s) across ${byRule.size} rule(s)\n`);
for (const [id, list] of byRule) {
  console.log(`  ${id} — ${list[0].why}`);
  for (const f of list.slice(0, 20)) {
    console.log(`    ${f.file}${f.line ? ':' + f.line : ''}  ${f.text}`);
  }
  if (list.length > 20) console.log(`    ... and ${list.length - 20} more`);
  console.log('');
}
process.exit(1);
