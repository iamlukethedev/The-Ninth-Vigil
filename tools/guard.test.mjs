#!/usr/bin/env node
/**
 * Guard self-test — proves the convention guard actually catches what it claims.
 *
 *   node tools/guard.test.mjs
 *
 * WHY THIS EXISTS. The guard had two gaps that no test would have caught,
 * because nothing tested it: its rule scope was POSIX-only, so under Windows
 * every rule was silently skipped and the guard reported OK on a file with
 * four separate violations; and `index.html` was never scanned, so a CDN
 * passed cleanly. Both were found by running the guard against its own rules
 * by hand — which is exactly the kind of one-off manual check this project
 * already knows does not survive.
 *
 * So the guard gets a regression test, in the same spirit as the other
 * measurable claims in this repo: a rule that can silently stop working is
 * indistinguishable from a rule that never existed.
 *
 * It builds a throwaway fixture repository in a temp dir, runs the real guard
 * against it, and asserts on the violations reported. It does not touch the
 * working tree and needs no browser, no network and no new dependency.
 *
 * Exit 0 = every case behaves as specified. Exit 1 = a case regressed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const GUARD = join(ROOT, 'tools', 'guard.mjs');

/* --- fixture helpers ---------------------------------------------------- */

function fixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `nona-guard-${name}-`));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  copyFileSync(GUARD, join(dir, 'tools', 'guard.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  return dir;
}

/** Run the guard in a fixture and return the rule ids it reported. */
function run(dir) {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [join(dir, 'tools', 'guard.mjs')], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    // A violation exits 1; that is a pass of the tool, not a crash.
    out = String(e.stdout ?? '');
    code = e.status ?? 1;
    if (e.stderr) out += String(e.stderr);
  }
  const rules = new Set();
  for (const m of out.matchAll(/^  ([a-z-]+) — /gm)) rules.add(m[1]);
  return { out, code, rules };
}

/* --- cases -------------------------------------------------------------- */

const cases = [];

function testCase(name, fn) { cases.push({ name, fn }); }

testCase('clean repo reports no violations', () => {
  const dir = fixture('clean');
  try {
    writeFileSync(join(dir, 'src', 'main.js'), "export const x = 1;\n");
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body><script type="module" src="/src/main.js"></script></body></html>\n');
    const r = run(dir);
    return r.code === 0 && r.rules.size === 0
      ? null
      : `expected exit 0 and no rules, got exit ${r.code} and rules [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('Math.random() in src/ is caught', () => {
  const dir = fixture('mathrandom');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export function f() { return Math.random(); }\n");
    const r = run(dir);
    return r.rules.has('no-math-random') ? null : `no-math-random not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a comment ASSERTING no Math.random() is not a violation', () => {
  const dir = fixture('mathcomment');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "// Math.random() is banned here.\nexport const x = 1;\n");
    const r = run(dir);
    return r.rules.has('no-math-random') ? 'flagged a comment — stripComments failed' : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('fetch() in src/ is caught', () => {
  const dir = fixture('fetch');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export function f() { return fetch('/x'); }\n");
    const r = run(dir);
    return r.rules.has('no-runtime-fetch') ? null : `no-runtime-fetch not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a remote URL in src/ is caught', () => {
  const dir = fixture('remoteurl');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export const u = 'https://cdn.example.com/x.js';\n");
    const r = run(dir);
    return r.rules.has('no-remote-urls') ? null : `no-remote-urls not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('an external asset path in src/ is caught', () => {
  const dir = fixture('asset');
  try {
    writeFileSync(join(dir, 'src', 'a.js'), "export const t = 'stone.png';\n");
    const r = run(dir);
    return r.rules.has('no-external-assets') ? null : `no-external-assets not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a CDN <script> in index.html is caught', () => {
  const dir = fixture('htmlcdn');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.min.js"></script></head></html>\n');
    const r = run(dir);
    return r.rules.has('no-remote-urls') ? null : `no-remote-urls not reported for index.html; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a protocol-relative CDN in index.html is caught', () => {
  const dir = fixture('htmlproto');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script src="//cdn.example.com/x.js"></script></head></html>\n');
    const r = run(dir);
    return r.rules.has('no-remote-urls') ? null : `protocol-relative URL not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a remote font in index.html is caught', () => {
  const dir = fixture('htmlfont');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel" /></head></html>\n');
    const r = run(dir);
    return r.rules.has('no-remote-urls') ? null : `remote font not reported; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a local asset in index.html is caught', () => {
  const dir = fixture('htmlasset');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="ui/theme.css" /></head></html>\n');
    const r = run(dir);
    return r.rules.has('no-external-assets') ? null : `no-external-assets not reported for index.html; got [${[...r.rules]}]`;
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
    const r = run(dir);
    return r.rules.has('no-remote-urls') ? 'flagged a URL in a comment — only real loads should count' : null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a relative module path in index.html is not a violation', () => {
  const dir = fixture('htmlrelative');
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><script type="module" src="/src/main.js"></script></head></html>\n');
    const r = run(dir);
    return r.rules.size === 0 ? null : `flagged a legitimate module path; got [${[...r.rules]}]`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a dependency outside the allowlist is caught', () => {
  const dir = fixture('dep');
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'f', version: '1.0.0', dependencies: { three: '^0.185.1', lodash: '^4.0.0' } }));
    const r = run(dir);
    return r.rules.has('no-new-deps') ? null : `no-new-deps not reported; got [${[...r.rules]}]`;
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
