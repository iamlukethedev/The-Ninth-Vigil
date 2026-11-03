#!/usr/bin/env node
/**
 * Path containment test — proves `tools/paths.mjs` refuses to leave the repo.
 *
 *   node tools/paths.test.mjs
 *
 * WHY THIS EXISTS. `crop.mjs`, `shot.mjs` and `live.mjs` all took a caller
 * path, resolved it against the repo root, and used it: `resolve()` collapses
 * `..`, so `--out="../../escape_test.png"` wrote two levels above the checkout.
 * A guard that silently stops guarding is indistinguishable from no guard at
 * all, so the rule gets the same treatment as the convention guard: a test on
 * the behaviour, not on the source text.
 *
 * These are behaviour contracts on the exported helper, which is the single
 * place every tool routes its own `--in=` / `--out=` argument through. A tool
 * that stops calling it cannot make these cases pass.
 *
 * Exit 0 = every case behaves as specified. Exit 1 = a case regressed.
 */
import { join, resolve, sep } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { ROOT, insideRepo, resolveInside, ensureRepoDir } from './paths.mjs';

/* --- helpers ------------------------------------------------------------ */

/** Return null for pass, or a complaint string for fail. */
function expectThrow(fn, mustMention = []) {
  let got;
  try {
    got = fn();
  } catch (e) {
    const msg = String(e?.message ?? e);
    for (const s of mustMention) {
      if (!msg.includes(s)) return `error message does not mention ${JSON.stringify(s)}; got: ${msg}`;
    }
    return null;
  }
  return `expected a throw, instead returned ${JSON.stringify(got)}`;
}

function expectInside(rel, expectedParts) {
  const abs = resolveInside(rel, '--out=');
  const want = join(ROOT, ...expectedParts);
  return abs === want ? null : `expected ${want}, got ${abs}`;
}

/* --- cases -------------------------------------------------------------- */

const cases = [];

function testCase(name, fn) { cases.push({ name, fn }); }

testCase('a normal relative path resolves to an absolute path inside the repo', () => {
  return expectInside('shots/_debug/crop.png', ['shots', '_debug', 'crop.png']);
});

testCase("'../x.png' is rejected for --out=", () => {
  return expectThrow(() => resolveInside('../x.png', '--out='), ['--out=', 'x.png']);
});

testCase("'../../escape.png' is rejected for --out=", () => {
  return expectThrow(() => resolveInside('../../escape.png', '--out='), ['escape.png']);
});

testCase('an absolute path outside the repo is rejected for --in=', () => {
  // A path that is outside on every platform: one level above this checkout.
  // On Windows resolve('C:\\', '/etc/passwd') keeps the drive, so a POSIX-only
  // literal would never be outside the root there and would test nothing.
  const outside = resolve(ROOT, '..', 'outside.png');
  return expectThrow(() => resolveInside(outside, '--in='), ['--in=']);
});

testCase("a sibling-prefix trick ('../<repo>-evil/x.png') is rejected", () => {
  // The naive `startsWith(ROOT + sep)` check survives this one, but a bare
  // `startsWith(ROOT)` does not: the sibling directory shares the prefix.
  const repoName = ROOT.split(sep).pop();
  return expectThrow(() => resolveInside(`../${repoName}-evil/x.png`, '--out='), ['-evil']);
});

testCase('the repo root itself is rejected for --out=', () => {
  return expectThrow(() => resolveInside('.', '--out='), ['--out=']);
});

testCase('backslash separators are normalised, not treated as filename characters', () => {
  const problem = expectInside('shots\\_debug\\crop.png', ['shots', '_debug', 'crop.png']);
  if (problem) return problem;
  // ... and traversal written with backslashes is still traversal, on every OS.
  return expectThrow(() => resolveInside('..\\..\\escape.png', '--out='), ['escape.png']);
});

testCase('the error names the argument and the escape target', () => {
  const abs = resolve(ROOT, '..', '..', 'escape_test.png');
  return expectThrow(() => resolveInside('../../escape_test.png', '--out='), ['--out=', abs]);
});

testCase('ensureRepoDir creates a missing output directory inside the repo', () => {
  // shots/_debug/ ships in no clone: it is gitignored. actors.mjs wrote its
  // screenshot into it without creating it, relying on the caller's cwd.
  const rel = 'shots/_debug/paths.test-probe';
  const abs = join(ROOT, 'shots', '_debug', 'paths.test-probe');
  try {
    rmSync(abs, { recursive: true, force: true });
    const got = ensureRepoDir(rel);
    if (got !== abs) return `expected ${abs}, got ${got}`;
    if (!existsSync(abs)) return 'directory was not created';
    return null;
  } finally {
    rmSync(abs, { recursive: true, force: true });
  }
});

testCase('ensureRepoDir refuses to create a directory outside the repo', () => {
  return expectThrow(() => ensureRepoDir('../escaped_dir'), ['escaped_dir']);
});

testCase('insideRepo agrees: in-repo paths yes, root and outside no', () => {
  if (!insideRepo(join(ROOT, 'shots', 'combat.png'))) return 'rejected a path inside the repo';
  if (insideRepo(ROOT)) return 'accepted the repo root itself';
  if (insideRepo(resolve(ROOT, '..'))) return 'accepted the parent of the repo root';
  return null;
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
  console.log(`paths.test: FAILED — ${failed} of ${cases.length} case(s) regressed\n`);
  process.exit(1);
}
console.log(`paths.test: OK — ${cases.length} cases`);
