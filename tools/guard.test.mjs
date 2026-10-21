#!/usr/bin/env node
/**
 * Guard self-test — proves the convention guard actually catches what it claims.
 *
 *   node tools/guard.test.mjs
 *
 * WHY THIS EXISTS. The guard had gaps that no test would have caught, because
 * nothing tested it: its rule scope was POSIX-only, so under Windows every rule
 * was silently skipped and the guard reported OK on a file with four separate
 * violations; and `index.html` was never scanned, so a CDN passed cleanly. Both
 * were found by running the guard against its own rules by hand — which is
 * exactly the kind of one-off manual check this project already knows does not
 * survive.
 *
 * So the guard gets a regression test, in the same spirit as the other
 * measurable claims in this repo: a rule that can silently stop working is
 * indistinguishable from a rule that never existed.
 *
 * It builds a throwaway fixture repository in a temp dir, runs the real guard
 * against it with `--json`, and asserts on the violations reported. It does not
 * touch the working tree and needs no browser, no network and no new
 * dependency.
 *
 * The assertions read the guard's JSON output rather than its human-readable
 * report, because a test that parses exact spacing and em dashes breaks when
 * someone rewords a message — and a test that breaks on a reword is a test
 * people stop running.
 *
 * Exit 0 = every case behaves as specified. Exit 1 = a case regressed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { normalizeRel, matchesScope, classifyValue } from './guard.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const GUARD = join(ROOT, 'tools', 'guard.mjs');

/* --- fixture helpers ---------------------------------------------------- */

function fixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `guard-fixture-${name}-`));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  copyFileSync(GUARD, join(dir, 'tools', 'guard.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  return dir;
}

/**
 * Run the guard in a fixture and return its JSON report.
 *
 * The JSON is the contract: `ok`, the counts, and the violation list. The
 * exit code is asserted alongside it, because a guard that reports violations
 * AND exits 0 cannot gate anything.
 */
function run(dir) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [join(dir, 'tools', 'guard.mjs'), '--json'], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    // A violation exits 1; that is a pass of the tool, not a crash.
    out = String(e.stdout ?? '');
    code = e.status ?? 1;
    if (e.stderr) out += String(e.stderr);
  }
  let json = null;
  try { json = JSON.parse(out); } catch { /* reported by the caller as a missing report */ }
  const rules = new Set((json?.violations ?? []).map((v) => v.id));
  return { out, code, json, rules };
}

/* Assert that a fixture produced a specific rule. */
function expectRule(r, rule) {
  if (!r.rules.has(rule)) return `${rule} not reported; got [${[...r.rules]}]`;
  return null;
}

/* Assert that a fixture produced NO violation at all, and exited 0. */
function expectClean(r) {
  if (r.code !== 0) return `expected exit 0, got ${r.code}`;
  if (!r.json) return 'guard produced no JSON report';
  if (r.json.violations.length) return `expected no violations, got [${[...r.rules]}]`;
  return null;
}

/* --- cases -------------------------------------------------------------- */

const cases = [];

function testCase(name, fn) { cases.push({ name, fn }); }

/* --- the path normalisation, which is what the Windows fix rests on --- */

testCase('normalizeRel turns a backslash path into a forward-slash path', () => {
  const got = normalizeRel('src\\game\\ai\\NavGrid.js');
  return got === 'src/game/ai/NavGrid.js'
    ? null
    : `expected "src/game/ai/NavGrid.js", got "${got}"`;
});

testCase('the src scope matches a backslash path, which is what Windows produces', () => {
  /* This is the case the original POSIX-only scope failed: on Windows,
     relative() returns `src\game\ai\NavGrid.js`, and the scope never matched,
     so every rule was skipped. */
  const scope = /^src\//;
  if (matchesScope(scope, 'src\\game\\ai\\NavGrid.js')) return null;
  return 'a backslash src/ path did not match the scope — the Windows regression is back';
});

testCase('the src scope still matches a forward-slash path', () => {
  return matchesScope(/^src\//, 'src/game/ai/NavGrid.js') ? null : 'a POSIX path failed to match the scope';
});

testCase('the src scope does not match a path outside src/', () => {
  return matchesScope(/^src\//, 'tools/guard.mjs') ? 'tools/ matched the src/ scope' : null;
});

testCase('classifyValue tells remote, asset and neither apart', () => {
  const checks = [
    ['https://cdn.example.com/x.js', 'remote'],
    ['//cdn.example.com/x.js', 'remote'],
    ['/src/main.js', null],
    ['stone.png', 'asset'],
    ['stone.png?v=2', 'asset'],
    ['ui/theme.css', 'asset'],
    ['', null],
  ];
  for (const [input, want] of checks) {
    const got = classifyValue(input);
    if (got !== want) return `classifyValue(${JSON.stringify(input)}) = ${got}, expected ${want}`;
  }
  return null;
});

/* --- the JS rules --- */

testCase('clean repo reports no violations and exits 0', () => {
  const dir = fixture('clean');
  try {
    writeFileSync(join(dir, 'src', 'main.js'), "export const x = 1;\n");
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n');
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('Math.random() in src/ is caught', () => {
  const dir = fixture('mathrandom');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export function f() { return Math.random(); }\n");
    return expectRule(run(dir), 'no-math-random');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a comment ASSERTING no Math.random() is not a violation', () => {
  const dir = fixture('mathcomment');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "// Math.random() is banned here.\nexport const x = 1;\n");
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('fetch() in src/ is caught', () => {
  const dir = fixture('fetch');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export function f() { return fetch('/x'); }\n");
    return expectRule(run(dir), 'no-runtime-fetch');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a remote URL in src/ is caught', () => {
  const dir = fixture('remoteurl');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export const u = 'https://cdn.example.com/x.js';\n");
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an external asset path in src/ is caught', () => {
  const dir = fixture('asset');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export const t = 'stone.png';\n");
    return expectRule(run(dir), 'no-external-assets');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a TODO stub in src/ is caught', () => {
  const dir = fixture('stub');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "// TODO: implement the real thing\nexport const x = 1;\n");
    return expectRule(run(dir), 'no-stub-code');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a file that does not parse is caught', () => {
  const dir = fixture('syntax');
  try {
    /* A `function` declaration with an unclosed body — `node --check` rejects
       it, which is what the guard's parse pass runs. Note that
       `export function f() { return 1;` does NOT fail: an unclosed body is
       legal at module top level, so that fixture would silently assert
       nothing. */
    writeFileSync(join(dir, 'src', 'broken.js'), "function f() { return 1;\n");
    return expectRule(run(dir), 'syntax');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --- the HTML rules --- */

testCase('a CDN <script> in index.html is caught', () => {
  const dir = fixture('htmlcdn');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.min.js"></script></head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a protocol-relative CDN in index.html is caught', () => {
  const dir = fixture('htmlproto');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="//cdn.example.com/x.js"></script></head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a remote font in index.html is caught', () => {
  const dir = fixture('htmlfont');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel" /></head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a local asset in index.html is caught', () => {
  const dir = fixture('htmlasset');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="ui/theme.css" /></head></html>\n');
    return expectRule(run(dir), 'no-external-assets');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an import map pointing at a CDN is caught', () => {
  const dir = fixture('htmlimportmap');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <script type="importmap">\n'
      + '  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js" } }\n'
      + '  </script>\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an inline module script importing from a CDN is caught', () => {
  const dir = fixture('htmlinlineimport');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <script type="module">\n'
      + "    import * as THREE from 'https://esm.sh/three@0.185.1';\n"
      + '  </script>\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a CSS @import of a remote font is caught', () => {
  const dir = fixture('htmlcssimport');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <style>\n'
      + "    @import url('https://fonts.googleapis.com/css2?family=Cinzel');\n"
      + '  </style>\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a CSS url() pointing at a remote image is caught', () => {
  const dir = fixture('htmlcssurl');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <style>\n'
      + "    body { background: url(https://cdn.example.com/bg.png); }\n"
      + '  </style>\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a srcset= pointing at a CDN is caught', () => {
  const dir = fixture('htmlsrcset');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <img srcset="https://cdn.example.com/a.png 1x, https://cdn.example.com/b.png 2x" alt="" />\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an UNQUOTED href= pointing at a CDN is caught', () => {
  const dir = fixture('htmlunquoted');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src=https://cdn.example.com/x.js></script></head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an asset path with a query string is caught', () => {
  const dir = fixture('htmlquery');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><img src="stone.png?v=2" alt="" /></head></html>\n');
    return expectRule(run(dir), 'no-external-assets');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a CDN in a SECOND html file is caught, not just index.html', () => {
  const dir = fixture('htmlsecond');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body></body></html>\n');
    writeFileSync(join(dir, 'about.html'), '<!doctype html><html><head><script src="https://cdn.example.com/x.js"></script></head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a plain <a href> to a remote page is NOT a violation', () => {
  const dir = fixture('htmlanchor');
  try {
    /* A hyperlink loads nothing until it is followed, so it is not a fetch.
       Flagging it would train people to ignore the rule. */
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><body><a href="https://github.com/iamlukethedev/The-Ninth-Vigil">repo</a></body></html>\n');
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a URL in index.html PROSE is not a violation', () => {
  const dir = fixture('htmlprose');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <!-- Built with Three.js — see https://threejs.org/docs -->\n'
      + '  <script type="module" src="/src/main.js"></script>\n'
      + '</head></html>\n');
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a relative module path in index.html is not a violation', () => {
  const dir = fixture('htmlrelative');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script type="module" src="/src/main.js"></script></head></html>\n');
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a data: URI image is not a violation', () => {
  const dir = fixture('htmldata');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><img src="data:image/svg+xml;base64,AAAA" alt="" /></body></html>\n');
    return expectClean(run(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --- the dependency allowlist --- */

testCase('a dependency outside the allowlist is caught', () => {
  const dir = fixture('dep');
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f', version: '1.0.0', dependencies: { three: '^0.185.1', lodash: '^4.0.0' } }));
    return expectRule(run(dir), 'no-new-deps');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --- run ---------------------------------------------------------------- */

let failed = 0;
for (const c of cases) {
  const problem = c.fn();
  if (problem) {
    failed++;
    console.log(`  ✗ ${c.name}\n      ${problem}`);
  } else {
    console.log(`  ✓ ${c.name}`);
  }
}

console.log('');
if (failed) {
  console.log(`guard.test: FAILED — ${failed} of ${cases.length} case(s) regressed\n`);
  process.exit(1);
}
console.log(`guard.test: OK — ${cases.length} cases`);
