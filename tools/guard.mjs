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
 *
 * Two gaps this now closes, both found by running the guard against its own
 * rules and both measured rather than reasoned about:
 *
 *   1. The rule scope was POSIX-only (`/^src\//`) while `relative()` returns
 *      backslash paths on Windows, so every rule was skipped under Windows and
 *      the guard reported OK on a file containing four separate violations.
 *      Paths are now NORMALISED to forward slashes before the scope test, so
 *      the scope is one convention on every platform — and the normalisation
 *      is a tested function, not an assumption.
 *   2. `index.html` was never scanned — it is where an external asset would
 *      actually be introduced, and it is named as integration spine in
 *      ENGINE_CONTRACT.md and .github/CODEOWNERS. Every `*.html` file is now
 *      checked, for remote URLs and external asset references. The rules also
 *      read script and style CONTENT, because a CDN usually arrives as an
 *      import map or an inline `import` rather than as a `src` attribute.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* fileURLToPath, not URL.pathname — the latter percent-encodes, so any checkout
   with a space in its path scans a directory that does not exist. */
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'shots']);

/* --- path normalisation ------------------------------------------------- *
 *
 * `relative()` returns native separators, so the same file is
 * `src/game/ai/NavGrid.js` on POSIX and `src\game\ai\NavGrid.js` on Windows.
 * A scope written for one is silently inert on the other — which is exactly
 * how the original POSIX-only scope ended up skipping every rule on Windows
 * while the parse check still ran and the guard still printed OK.
 *
 * Normalising once, here, means every scope below can be written in the one
 * convention, and it means the fix is a tested function rather than a
 * tolerant regex that is easy to revert by accident.
 */
export function normalizeRel(rel) {
  return String(rel).split(sep).join('/');
}

/** Does a rule scope match a repository-relative path? */
export function matchesScope(scope, rel) {
  if (!scope) return true;
  return scope.test(normalizeRel(rel));
}

/* Only scan when invoked directly, so `guard.test.mjs` can import the helpers
   above without triggering a scan of the real repository. */
const IS_MAIN = !!process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

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

/* Scope is a NORMALISED, forward-slash path — see normalizeRel above. The
   original scope was /^src\// against a raw `relative()` string, which on
   Windows is `src\game\ai\NavGrid.js` and matched nothing, so all five rules
   were skipped for every Windows contributor while the parse check still ran
   and the guard still printed OK. */
const SRC_SCOPE = /^src\//;

const RULES = [
  {
    id: 'no-math-random',
    why: 'Determinism is mandatory — two captures of a scenario must be byte-identical. Use engine.rand(seed).',
    re: /\bMath\s*\.\s*random\s*\(/g,
    scope: SRC_SCOPE,
  },
  {
    id: 'no-runtime-fetch',
    why: 'No network at runtime. Everything is procedural or inlined.',
    re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bimportScripts\s*\(/g,
    scope: SRC_SCOPE,
  },
  {
    id: 'no-remote-urls',
    why: 'No CDNs, no remote textures, no remote fonts.',
    re: /["'`]https?:\/\//g,
    scope: SRC_SCOPE,
  },
  {
    id: 'no-external-assets',
    why: 'No external assets, ever. Generate it in src/core/texgen/ instead.',
    re: /["'`][^"'`\n]*\.(png|jpe?g|gif|webp|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|glb|gltf|fbx|obj|dae|hdr|exr|ktx2?|basis)["'`]/gi,
    scope: SRC_SCOPE,
  },
  {
    id: 'no-stub-code',
    why: 'Write real code. No placeholder implementations.',
    re: /TODO:\s*implement|FIXME:\s*stub|throw new Error\(\s*["'`]not implemented/gi,
    scope: SRC_SCOPE,
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

/* ------------------------------------------------------------------ *
 * HTML entry points
 * ------------------------------------------------------------------ *
 * The JS walker above never sees an HTML file, and an HTML file is where an
 * external asset would ACTUALLY be introduced — a CDN `<script>`, an import
 * map, a remote font in a `<style>` block. `index.html` is named as
 * integration spine in both ENGINE_CONTRACT.md and .github/CODEOWNERS.
 *
 * Four findings shaped these rules, each measured rather than assumed:
 *
 *   - A plain `<a href="https://...">` is a LINK, not a load. The browser
 *     fetches nothing until it is followed, so it is not a violation. Only
 *     elements that cause a subresource fetch are matched.
 *   - The load is not always in an attribute. An import map, an inline
 *     `<script type="module">` importing from a CDN, and a `<style>` block
 *     with `@import url(...)` all pull remote code or assets with no `src` or
 *     `href` in sight. Script and style CONTENT is scanned too.
 *   - A URL outside a src/href attribute is not a violation — but a
 *     COMMENTED-OUT `<script src="https://...">` is, because it is one edit
 *     from being live, and flagging it is the cheap direction to be wrong in.
 *     The rule is about what the page LOADS, not about what it mentions.
 *   - An asset path may carry a query string or a fragment
 *     (`stone.png?v=2`), which a plain extension match missed.
 */

/* Elements whose URL attributes make the browser fetch something.
   `<a>` is deliberately absent — a hyperlink loads nothing until followed. */
const HTML_LOADING_TAGS = new Set([
  'script', 'link', 'img', 'image', 'source', 'audio', 'video', 'iframe',
  'embed', 'object', 'track', 'input', 'use', 'base',
]);

/* Attributes that carry a URL the browser will act on. */
const HTML_URL_ATTRS = new Set([
  'src', 'href', 'srcset', 'poster', 'data', 'xlink:href',
  'action', 'formaction', 'background', 'manifest', 'codebase',
]);

/* One attribute, quoted or unquoted. */
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/* One tag. The alternation lets a `>` sit inside a quoted attribute value. */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/* A script or style block, with its attributes and its content. */
const BLOCK_RE = /<(script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>/gi;

/* A quoted string inside script or style content. */
const INLINE_STRING_RE = /(["'`])([^"'`\n]*)\1/g;

/* A CSS url() reference. */
const INLINE_URL_RE = /url\(\s*([^)]*?)\s*\)/gi;

/* A remote URL introduced by a quote, a backtick or a paren. The prefix
   match is deliberate: "see https://..." inside a string is still a remote
   URL, and a CDN is free to hide behind a longer string. */
const INLINE_REMOTE_RE = /["'(`]\s*(?:https?:\/\/|\/\/)/gi;

/* An absolute or protocol-relative URL, as a whole value. */
const REMOTE_VALUE_RE = /^(?:https?:)?\/\//i;

/* A local asset path, optionally carrying a query string or a fragment. */
const ASSET_VALUE_RE = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|glb|gltf|fbx|obj|dae|hdr|exr|ktx2?|basis|webm|aac|css|svg)(?:[?#][^\s]*)?$/i;

const HTML_RULES = [
  {
    id: 'no-remote-urls',
    why: 'No CDNs, no remote textures, no remote fonts. The page must not reference anything over the network.',
  },
  {
    id: 'no-external-assets',
    why: 'No external assets, ever. Generate it in src/core/texgen/ instead.',
  },
];

/** Classify a URL-ish value: 'remote', 'asset', or null. */
export function classifyValue(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (REMOTE_VALUE_RE.test(s)) return 'remote';
  if (ASSET_VALUE_RE.test(s)) return 'asset';
  return null;
}

function report(failures, id, file, line, text) {
  const rule = HTML_RULES.find((r) => r.id === id);
  failures.push({ id, file, line, text: String(text).trim(), why: rule.why });
}

/** The URL-bearing attributes of one tag, and what each of them points at. */
function scanTagAttrs(tagName, attrString, file, line, failures) {
  if (!HTML_LOADING_TAGS.has(tagName)) return;
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(attrString)) !== null) {
    const name = m[1].toLowerCase();
    if (!HTML_URL_ATTRS.has(name)) continue;
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    /* srcset holds a comma-separated candidate list: "a.png 1x, b.png 2x". */
    const candidates = name === 'srcset'
      ? value.split(',').map((c) => c.trim().split(/\s+/)[0]).filter(Boolean)
      : [value];
    for (const c of candidates) {
      const kind = classifyValue(c);
      if (kind === 'remote') report(failures, 'no-remote-urls', file, line, c);
      else if (kind === 'asset') report(failures, 'no-external-assets', file, line, c);
    }
  }
}

/** The content of a script or style block: imports, @import, url(). */
function scanInlineContent(content, file, line, failures) {
  /* Remote: a URL introduced by a quote, a backtick or a paren. */
  INLINE_REMOTE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_REMOTE_RE.exec(content)) !== null) {
    const at = line + content.slice(0, m.index).split('\n').length - 1;
    report(failures, 'no-remote-urls', file, at, m[0]);
  }
  /* Asset: a local asset path in a string or a url() call. */
  const candidates = [];
  INLINE_STRING_RE.lastIndex = 0;
  while ((m = INLINE_STRING_RE.exec(content)) !== null) candidates.push(m[2]);
  INLINE_URL_RE.lastIndex = 0;
  while ((m = INLINE_URL_RE.exec(content)) !== null) candidates.push(m[1]);
  for (const c of candidates) {
    if (classifyValue(c) === 'asset') {
      const at = line + content.slice(0, content.indexOf(c)).split('\n').length - 1;
      report(failures, 'no-external-assets', file, at, c);
    }
  }
}

/** Scan one HTML file for remote URLs and external asset references. */
export function scanHtml(text, file, failures) {
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;

  /* Pass 1: script and style blocks — the tag's attributes AND the content. */
  let rest = text;
  BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_RE.exec(text)) !== null) {
    const [full, tag, attrs, content] = m;
    const startLine = lineAt(m.index);
    scanTagAttrs(tag.toLowerCase(), attrs, file, startLine, failures);
    /* The content begins after the open tag, so its first line is the open
       tag's line plus however many newlines the tag itself spanned. */
    const openTagEnd = full.indexOf('>') + 1;
    const head = full.slice(0, openTagEnd);
    const contentLine = startLine + head.split('\n').length - 1;
    scanInlineContent(content, file, contentLine, failures);
    /* Blank the block out of the general pass, preserving newlines so the
       line numbers below still point at the real source. */
    rest = rest.replace(full, full.replace(/[^\n]/g, ' '));
  }

  /* Pass 2: every other tag. */
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(rest)) !== null) {
    scanTagAttrs(m[1].toLowerCase(), m[2], file, lineAt(m.index), failures);
  }
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
export function runGuard({ root = ROOT, json = false } = {}) {
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
    /* NORMALISED, so the scope below is one convention on every platform. */
    const rel = normalizeRel(relative(root, p));
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

function main() {
  const report = runGuard({ json: process.argv.includes('--json') });

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
}

if (IS_MAIN) main();
