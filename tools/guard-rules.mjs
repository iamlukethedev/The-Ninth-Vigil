/**
 * Convention guard — the pure rules, with no I/O and no side effects.
 *
 *   node tools/guard.mjs
 *
 * This module is imported by `tools/guard.test.mjs`, so it must never run a
 * scan and must never exit: it holds the rules and the path conventions, and
 * `guard.mjs` is the only thing that decides when to actually run them.
 *
 * Keeping the two apart is not tidiness. The direct-run check is the one
 * component whose failure mode is silence: if it ever misfires, a
 * self-referential guard is left with nothing to compare against, exits 0 and
 * CI reads a pass. Splitting the rules out means `guard.mjs` runs on EVERY
 * invocation, so the detection cannot fail closed into a silent success —
 * there is no path where the tool starts and does nothing.
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
 * Two gaps this closed, both found by running the guard against its own rules
 * and both measured rather than reasoned about:
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

/* --- path normalisation ------------------------------------------------- *
 *
 * `relative()` returns native separators, so the same file is
 * `src/game/ai/NavGrid.js` on POSIX and `src\game\ai\NavGrid.js` on Windows.
 * A scope written for one is silently inert on the other — which is exactly
 * how the original POSIX-only scope ended up skipping every rule on Windows
 * while the parse check still ran and the guard still printed OK.
 *
 * The replacement is unconditional, NOT `split(sep).join('/')`: `sep` is `/`
 * on POSIX, so a Windows-style path handed to a POSIX guard would come back
 * untouched and still miss a `/^src\//` scope. Normalising by rewriting every
 * backslash makes the function identical on both platforms, which is what
 * lets the tests below construct Windows paths explicitly and assert the same
 * behaviour on every platform.
 */
export function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/');
}

/** Does a rule scope match a repository-relative path? */
export function matchesScope(scope, rel) {
  if (!scope) return true;
  return scope.test(normalizeRel(rel));
}

/**
 * Blank out comments, preserving line and column positions so reported line
 * numbers still point at the real source. Strings and template literals are
 * preserved, because a banned pattern inside a string literal is a real
 * violation (an asset path, a CDN URL) and must still be caught.
 */
export function stripComments(src) {
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
export const SRC_SCOPE = /^src\//;

export const RULES = [
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
export const HTML_LOADING_TAGS = new Set([
  'script', 'link', 'img', 'image', 'source', 'audio', 'video', 'iframe',
  'embed', 'object', 'track', 'input', 'use', 'base',
]);

/* Attributes that carry a URL the browser will act on. */
export const HTML_URL_ATTRS = new Set([
  'src', 'href', 'srcset', 'poster', 'data', 'xlink:href',
  'action', 'formaction', 'background', 'manifest', 'codebase',
]);

/* One attribute, quoted or unquoted. */
export const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;

/* One tag. The alternation lets a `>` sit inside a quoted attribute value. */
export const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

/* A script or style block, with its attributes and its content. */
export const BLOCK_RE = /<(script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>/gi;

/* A quoted string inside script or style content. */
export const INLINE_STRING_RE = /(["'`])([^"'`\n]*)\1/g;

/* A CSS url() reference. */
export const INLINE_URL_RE = /url\(\s*([^)]*?)\s*\)/gi;

/* A remote URL introduced by a quote, a backtick or a paren.
 *
 * A protocol-relative reference requires a HOST after `//`: `//cdn.example.com/x.js`
 * is a load, but `'// note'` is a string that merely starts with two slashes.
 * Without the host requirement the two are indistinguishable, so every inline
 * string that began `//` was reported as a remote URL. */
export const INLINE_REMOTE_RE = /["'(`]\s*(?:https?:\/\/|(?:\/\/)[^\s"'`]+)/gi;

/* An absolute or protocol-relative URL, as a whole value. */
export const REMOTE_VALUE_RE = /^(?:https?:)?\/\/[^\s/]/i;

/* A local asset path, optionally carrying a query string or a fragment. */
export const ASSET_VALUE_RE = /\.(png|jpe?g|gif|webp|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|glb|gltf|fbx|obj|dae|hdr|exr|ktx2?|basis|webm|aac|css|svg)(?:[?#][^\s]*)?$/i;

export const HTML_RULES = [
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

export function report(failures, id, file, line, text) {
  const rule = HTML_RULES.find((r) => r.id === id);
  failures.push({ id, file, line, text: String(text).trim(), why: rule.why });
}

/** Line number of a byte offset within `content`, where `content` starts on `line`. */
function lineOf(content, index, line) {
  return line + content.slice(0, index).split('\n').length - 1;
}

/** The URL-bearing attributes of one tag, and what each of them points at. */
export function scanTagAttrs(tagName, attrString, file, line, failures) {
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
export function scanInlineContent(content, file, line, failures) {
  /* Remote: a URL introduced by a quote, a backtick or a paren. */
  INLINE_REMOTE_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_REMOTE_RE.exec(content)) !== null) {
    report(failures, 'no-remote-urls', file, lineOf(content, m.index, line), m[0]);
  }
  /* Asset: a local asset path in a string or a url() call. Each candidate is
     located by SEARCHING FROM where the previous one was found, so a value
     repeated inside the same block reports its own line rather than always
     the first occurrence. */
  const candidates = [];
  INLINE_STRING_RE.lastIndex = 0;
  while ((m = INLINE_STRING_RE.exec(content)) !== null) candidates.push({ value: m[2], from: m.index + 1 });
  INLINE_URL_RE.lastIndex = 0;
  while ((m = INLINE_URL_RE.exec(content)) !== null) candidates.push({ value: m[1], from: m.index + 1 });
  let from = 0;
  for (const { value, from: start } of candidates) {
    if (classifyValue(value) !== 'asset') continue;
    const at = content.indexOf(value, from);
    report(failures, 'no-external-assets', file, lineOf(content, at < 0 ? start : at, line), value);
    from = Math.max(start, at < 0 ? start : at) + value.length;
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
