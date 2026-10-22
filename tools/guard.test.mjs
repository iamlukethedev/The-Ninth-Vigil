#!/usr/bin/env node
/**
 * Guard self-test — proves the convention guard actually catches what it claims.
 *
 *   node tools/guard.test.mjs          (or: npm run guard:test)
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
 * THE FIXTURES ARE EXPLICITLY SEPARATED BY PLATFORM. `fixture()` copies
 * `guard.mjs` and `guard-rules.mjs` into the fixture's `tools/`, because the
 * guard resolves its root from its OWN location — run it from a path whose
 * parent is not the repository and it scans the repository that holds it.
 * `fixtureWindowsPaths()` additionally adds a `src\game\` DIRECTORY, whose name
 * contains a literal backslash. That is what makes this suite platform-proof:
 * a fixture whose source paths are backslash-shaped behaves as a Windows
 * checkout on Linux, macOS and Windows alike, so a revert of the normalisation
 * is detected on every platform instead of only on the `windows-latest` job.
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeRel, matchesScope, classifyValue } from './guard-rules.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

/* --- fixture helpers ---------------------------------------------------- */

function fixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `guard-fixture-${name}-`));
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  copyFileSync(join(ROOT, 'tools', 'guard.mjs'), join(dir, 'tools', 'guard.mjs'));
  copyFileSync(join(ROOT, 'tools', 'guard-rules.mjs'), join(dir, 'tools', 'guard-rules.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  return dir;
}

/* A fixture whose source paths carry WINDOWS separators. The directory name
   contains a literal backslash, so `relative(root, p)` returns
   `src\game\a.js` here — and on Linux the same string is what a POSIX checkout
   would produce if the normalisation were reverted. */
function fixtureWindowsPaths(name) {
  const dir = fixture(name);
  mkdirSync(join(dir, 'src\\game'));
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

/* --- the path normalisation, which is what the cross-platform fix rests on --- */

testCase('normalizeRel turns a backslash path into a forward-slash path', () => {
  const got = normalizeRel('src\\game\\ai\\NavGrid.js');
  return got === 'src/game/ai/NavGrid.js'
    ? null
    : `expected "src/game/ai/NavGrid.js", got "${got}"`;
});

testCase('normalizeRel is platform-independent: it rewrites backslashes even when path.sep is a forward slash', () => {
  /* The bug: `split(sep).join('/')` is a no-op on POSIX, so a backslash path
     handed to a POSIX guard came back unchanged and missed a /^src\// scope.
     Asserted explicitly rather than derived from `path.sep`, so it holds on
     every platform. */
  const got = normalizeRel('src\\game\\ai\\NavGrid.js');
  return got === 'src/game/ai/NavGrid.js'
    ? null
    : `expected backslashes to be rewritten, got "${got}"`;
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

testCase('a Windows-shaped path END TO END: backslash dirs still get every rule', () => {
  /* The regression that mattered was not the unit function but the SCOPE:
     with a reverted normalisation the five src/ rules are skipped entirely, so
     a file in `src\` carrying four violations reports OK. These paths are
     constructed as backslashes explicitly, so a revert is caught here on
     Linux and macOS too — not only on the Windows job. */
  const dir = fixtureWindowsPaths('winpaths');
  try {
    writeFileSync(join(dir, 'src\\game', 'a.js'),
      "export function f() { return Math.random(); }\n"
      + "export function g() { return fetch('/x'); }\n"
      + "export const u = 'https://cdn.example.com/x.js';\n"
      + "export const t = 'stone.png';\n");
    const r = run(dir);
    for (const rule of ['no-math-random', 'no-runtime-fetch', 'no-remote-urls', 'no-external-assets']) {
      const problem = expectRule(r, rule);
      if (problem) return problem;
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

testCase('a protocol-relative CDN in an inline script is caught', () => {
  const dir = fixture('htmlinlineproto');
  try {
    /* `'//cdn.example.com/x.js'` has a HOST after `//`, so it is a load. It
       shares a block with the bare `'// note'` case below, which is not. */
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <script type="module">\n'
      + "    import * as x from '//cdn.example.com/x.js';\n"
      + '  </script>\n'
      + '</head></html>\n');
    return expectRule(run(dir), 'no-remote-urls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('a bare `//` in a string is NOT a remote URL', () => {
  const dir = fixture('htmlslashnote');
  try {
    /* `'// note'` starts with two slashes but has no host, so it is not a
       fetch. Flagging it would train people to ignore the rule. */
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <script type="module">\n'
      + "    const note = '// note';\n"
      + "    const label = '// TODO: explain this';\n"
      + '  </script>\n'
      + '</head></html>\n');
    return expectClean(run(dir));
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

testCase('a repeated asset value reports each occurrence on its own line', () => {
  /* `stone.png` appears twice in the same block. `content.indexOf(c)` always
     resolved to the FIRST occurrence, so the second hit was reported on the
     first one's line. */
  const dir = fixture('htmlrepeat');
  try {
    writeFileSync(join(dir, 'index.html'),
      '<!doctype html><html><head>\n'
      + '  <script type="module">\n'
      + "    const a = 'stone.png';\n"
      + "    const b = 'stone.png';\n"
      + '  </script>\n'
      + '</head></html>\n');
    const r = run(dir);
    const hits = (r.json?.violations ?? []).filter((v) => v.id === 'no-external-assets' && v.file === 'index.html');
    if (hits.length !== 2) return `expected 2 asset hits, got ${hits.length} (${JSON.stringify(hits.map((h) => [h.line, h.text]))})`;
    const lines = hits.map((h) => h.line).sort((a, b) => a - b);
    if (lines[0] === lines[1]) return `both hits reported line ${lines[0]} — a repeated value is not located per occurrence`;
    if (lines[0] !== 3 || lines[1] !== 4) return `expected lines 3 and 4, got ${JSON.stringify(lines)}`;
    return null;
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

/* --- the direct-run guarantee ------------------------------------------- *
 *
 * The guard used to decide whether to run with a self-referential
 * `import.meta.url` comparison. If that check ever misfired, the tool started,
 * did nothing, and exited 0 — which CI reads as a pass. The rules now live in
 * `guard-rules.mjs` and `guard.mjs` runs unconditionally, so that failure mode
 * is gone by construction. These two cases pin the property instead of assuming
 * it: importing the rules must not scan, and invoking the guard must always
 * produce a report. */

testCase('importing guard-rules.mjs does not run a scan or exit the process', async () => {
  const dir = fixture('importsideeffect');
  try {
    /* `guard-rules.mjs` holds no I/O. If it ever gained an import side effect
       that scanned or exited, this dynamic import would reject or kill the
       suite — a failure, never a silent pass. */
    /* `pathToFileURL`, not a bare path: on Windows an absolute path is not a
       valid ESM specifier. */
    const mod = await import(pathToFileURL(join(dir, 'tools', 'guard-rules.mjs')).href);
    return typeof mod.normalizeRel === 'function' && typeof mod.scanHtml === 'function'
      ? null
      : 'guard-rules.mjs did not export the expected helpers';
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

testCase('the guard ALWAYS reports: an invocation can never silently exit 0', () => {
  /* A guard that decided "I was imported, so I will do nothing" exited 0
     without ever reporting. There is no such branch any more, so every
     invocation must produce a JSON report — including this clean fixture. */
  const dir = fixture('alwaysreports');
  try {
    writeFileSync(join(dir, 'src', 'main.js'), "export const x = 1;\n");
    const r = run(dir);
    if (!r.json) return `guard produced no JSON report (stdout: ${JSON.stringify(r.out.slice(0, 200))})`;
    if (typeof r.json.files !== 'number') return 'guard report has no file count — it did not actually scan';
    if (r.json.files === 0) return 'guard reported 0 files — it scanned nothing';
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* --- run ---------------------------------------------------------------- */

let failed = 0;
for (const c of cases) {
  const problem = await c.fn();
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
