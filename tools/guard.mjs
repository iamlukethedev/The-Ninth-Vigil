#!/usr/bin/env node
/**
 * Convention guard — the project's hard rules, enforced.
 *
 *   node tools/guard.mjs
 *
 * Fast, no browser, no network. Run it before you push; CI runs it as a gate.
 *
 * The rules it checks are the ones in ENGINE_CONTRACT.md that a reviewer cannot
 * reliably catch by eye, and each has already cost this project real time:
 * a single `Math.random()` makes every capture drift and silently invalidates
 * the whole visual-review loop, and a single external asset breaks the one
 * constraint the project exists to honour.
 *
 * Comments are stripped before matching, via a small scanner that tracks
 * strings and template literals. That matters here more than usual: ~40 files
 * carry comments that *assert* there is no `Math.random()`, so a naive grep
 * reports 40 violations in a codebase that has none.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* fileURLToPath, not URL.pathname — the latter percent-encodes, so any checkout
   with a space in its path scans a directory that does not exist. */
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'shots']);

/**
 * Blank out comments, preserving line and column positions so reported line
 * numbers still point at the real source. Strings and template literals are
 * preserved, because a banned pattern inside a string literal is a real
 * violation (an asset path, a CDN URL) and must still be caught.
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

const RULES = [
  {
    id: 'no-math-random',
    why: 'Determinism is mandatory — two captures of a scenario must be byte-identical. Use engine.rand(seed).',
    re: /\bMath\s*\.\s*random\s*\(/g,
    scope: /^src\//,
  },
  {
    id: 'no-runtime-fetch',
    why: 'No network at runtime. Everything is procedural or inlined.',
    re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bimportScripts\s*\(/g,
    scope: /^src\//,
  },
  {
    id: 'no-remote-urls',
    why: 'No CDNs, no remote textures, no remote fonts.',
    re: /["'`]https?:\/\//g,
    scope: /^src\//,
  },
  {
    id: 'no-external-assets',
    why: 'No external assets, ever. Generate it in src/core/texgen/ instead.',
    re: /["'`][^"'`\n]*\.(png|jpe?g|gif|webp|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|glb|gltf|fbx|obj|dae|hdr|exr|ktx2?|basis)["'`]/gi,
    scope: /^src\//,
  },
  {
    id: 'no-stub-code',
    why: 'Write real code. No placeholder implementations.',
    re: /TODO:\s*implement|FIXME:\s*stub|throw new Error\(\s*["'`]not implemented/gi,
    scope: /^src\//,
    /* Checked against raw source: the contract bans the TODO *comment* itself,
       so this is the one rule that must see comments. */
    raw: true,
  },
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.mjs'].includes(extname(e)) && !e.endsWith('.tmp.mjs')) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const failures = [];

/* --- 1. every file must parse --- */
for (const p of files) {
  try {
    execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' });
  } catch (e) {
    failures.push({ id: 'syntax', file: relative(ROOT, p), line: 0, text: String(e.stderr).split('\n')[1] ?? 'parse error', why: 'File does not parse.' });
  }
}

/* --- 2. convention rules, comments stripped --- */
for (const p of files) {
  const rel = relative(ROOT, p);
  const raw = readFileSync(p, 'utf8');
  const stripped = stripComments(raw);
  for (const rule of RULES) {
    if (rule.scope && !rule.scope.test(rel)) continue;
    const lines = (rule.raw ? raw : stripped).split('\n');
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(line);
      if (m) failures.push({ id: rule.id, file: rel, line: i + 1, text: m[0].trim(), why: rule.why });
    });
  }
}

/* --- 3. dependency allowlist --- */
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
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

/* --- report --- */
if (!failures.length) {
  console.log(`guard: OK — ${files.length} files, ${RULES.length + 2} rules, 0 violations`);
  process.exit(0);
}

const byRule = new Map();
for (const f of failures) {
  if (!byRule.has(f.id)) byRule.set(f.id, []);
  byRule.get(f.id).push(f);
}
console.log(`guard: ${failures.length} violation(s) across ${byRule.size} rule(s)\n`);
for (const [id, list] of byRule) {
  console.log(`  ${id} — ${list[0].why}`);
  for (const f of list.slice(0, 20)) {
    console.log(`    ${f.file}${f.line ? ':' + f.line : ''}  ${f.text}`);
  }
  if (list.length > 20) console.log(`    ... and ${list.length - 20} more`);
  console.log('');
}
process.exit(1);
