#!/usr/bin/env node
/**
 * One place that turns a caller-supplied `--in=` / `--out=` path into an
 * absolute path, and refuses the ones that leave the checkout.
 *
 * WHY THIS EXISTS. These tools resolve their arguments against the repo root,
 * and `resolve()` collapses `..`, so `--out="../../escape_test.png"` quietly
 * wrote two levels above the repository. `SECURITY.md` puts `tools/` in scope
 * and the project's whole claim is "nothing leaves the machine", so a dev CLI
 * that will write to an arbitrary path on request is a hole in exactly that
 * promise. The check lives here rather than in each tool because three copies
 * of a security rule is three chances for one of them to be dropped.
 *
 * It fails loudly and never clamps: silently redirecting `../../x.png` back
 * into the repo would hide the mistake instead of naming it.
 */
import { resolve, relative, isAbsolute } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Repository root — the directory that contains `tools/`. */
export const ROOT = resolve(import.meta.dirname, '..');

/**
 * True only for a path strictly inside ROOT. The root itself is not "inside"
 * it: `--out=.` is a directory, never a file these tools can write.
 *
 * `relative()` is used instead of `startsWith(ROOT + sep)` because the string
 * form has two traps: a sibling that shares the prefix (`<repo>-evil/`) passes
 * a bare `startsWith(ROOT)`, and a root that already ends in a separator
 * (`C:\` for a checkout at a drive root, `/` for one at a filesystem root)
 * would compare against `C:\\` and reject every path including valid ones.
 */
export function insideRepo(abs) {
  const rel = relative(ROOT, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve `p` (a caller argument, relative to ROOT) and assert it stays inside
 * the repo. `label` is the argument as the user typed it, so the error names
 * what they wrote rather than only what the tool did with it.
 *
 * Backslashes are normalised to forward slashes first. On POSIX a backslash is
 * a legal filename character, so `..\..\escape.png` would otherwise be read as
 * one innocent filename inside the repo — the same argument would then be
 * contained on Linux and an escape on Windows, which is not a rule.
 */
export function resolveInside(p, label) {
  const raw = String(p);
  const abs = resolve(ROOT, raw.split('\\').join('/'));
  if (!insideRepo(abs)) {
    throw new Error(
      `${label} must stay inside the repository — ` +
        `"${raw}" resolves to ${abs}, outside ${ROOT}. ` +
        `Give a path relative to the repo root, e.g. ${label}shots/_debug/out.png`
    );
  }
  return abs;
}

/**
 * Resolve a repo-relative directory and create it, returning the absolute path.
 *
 * `shots/_debug/` is gitignored, so it does not exist in a fresh clone. Creating
 * it belongs next to the path resolution rather than in each tool: `crop`,
 * `shot` and `live` all did this inline and `actors` quietly did not.
 */
export function ensureRepoDir(rel) {
  const abs = resolveInside(rel, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}
