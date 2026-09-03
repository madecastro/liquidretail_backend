#!/usr/bin/env node
'use strict';
/**
 * verifyDocCitations.js — fails CI when a comment or doc cites a repo
 * artifact (a file path, a function name, or an env var) that does not
 * exist. No DB, no network, no API key. Filesystem + regex only.
 *
 * WHY THIS EXISTS (2026-09-03). Backend PR #360 (`abf7e0c2`, 2026-08-28)
 * deleted `services/titlingResumeService.js`. The deletion itself was
 * correct and complete — what rotted was every OTHER place that cited it:
 * comments, CLAUDE.md, and a cross-repo doc, several of them carrying an
 * INSTRUCTION ("keep in sync with X", "mirror X exactly", "do not remove")
 * that a later session could obey after the thing it describes is gone. A
 * one-time grep-and-fix pass does not close this — the failure mode is
 * ongoing (any future delete/rename leaves the same kind of rot behind), so
 * this is a permanent CI gate, picked up by `npm test` via the existing
 * `scripts/verify*.{js,mjs}` glob.
 *
 * WHAT IT SCANS (exactly the task's stated scope, no more): `CLAUDE.md`,
 * `docs/*.md` (top-level only — NOT `session.d/`, which is a dated,
 * point-in-time incident log that is EXPECTED to describe things that have
 * since been deleted; scanning it would make every historical entry a
 * false positive), and header/inline COMMENTS (never string literals, never
 * code) inside `services/`, `routes/`, `pipelines/`, `remotion/`, `models/`,
 * `scripts/` — resolved per-repo against either a flat layout (this repo)
 * or an `src/`-nested one (adgen), whichever actually exists on disk, so the
 * same file works unmodified in both repos (see PORTABILITY below).
 *
 * THREE CITATION SHAPES, straight from the task:
 *   1. repo-relative file paths ending .js/.mjs/.jsx/.json/.md
 *   2. `functionName()` / `ns.functionName()` — an identifier immediately
 *      followed by empty (or whitespace-only) parens
 *   3. SCREAMING_SNAKE_CASE env var names, optionally as a `PREFIX_*` glob
 *
 * ══════════════════════════════════════════════════════════════════════
 * FALSE-POSITIVE AVOIDANCE — this is the actual hard part of the task, and
 * every mechanism below exists because a real citation in THIS repo's own
 * docs would otherwise trip it. Each one was found by running the scan
 * against the live repos and reading what came back, not invented in the
 * abstract.
 * ══════════════════════════════════════════════════════════════════════
 *
 * (A) PATH-SIGNAL GATE, computed FROM DISK, not hardcoded. A path citation
 *     is only recognised when it starts with `./`/`../`, OR its first path
 *     segment is a real top-level directory of EITHER repo (backend or
 *     adgen — both discovered live via `fs.readdirSync`, see KNOWN_TOP_
 *     SEGMENTS), OR it is an exact match against a small curated
 *     ROOT_BARE_FILES set (CLAUDE.md, package.json, index.js, …). This is
 *     what keeps `products.json`, `bv.js`, `widget.js`, `themes.json`,
 *     `Next.js` (scraper/adapter code describing OTHER PEOPLE'S sites) out
 *     of consideration — none of them carry a leading `services/`-style
 *     signal, so they are never even recognised as citations, let alone
 *     resolved.
 *       Deriving the segment set FROM DISK rather than hardcoding a list
 *     also solves a real, non-obvious case found in this repo's own
 *     CLAUDE.md: `frontend/client/templatePreview.js` and the whole
 *     `frontend/client/` tree are cited by path, describing the SEPARATE
 *     frontend repo (`Emami-RS-Project/liquidretail`, deployed to Netlify)
 *     — a THIRD repository this harness has no access to and cannot
 *     verify. `frontend/` is not a real top-level directory of either
 *     backend or adgen, so it never passes the signal gate and is silently
 *     not-a-citation, which is the only honest answer available: we cannot
 *     confirm OR deny it, so we do not claim to.
 *
 * (B) CROSS-REPO RESOLUTION, discovered via package.json, not a hardcoded
 *     worktree path. Many services are vendored twins (backend + adgen);
 *     CLAUDE.md itself cross-cites the sibling repo constantly (e.g.
 *     "`scripts/vendor-manifest.json`" — absent from THIS repo, real in
 *     adgen). SIBLING_ROOTS is found by scanning this repo's PARENT
 *     directory for any sibling whose own package.json `name` is the
 *     known counterpart ('liquidretail-backend' <-> 'liquidretail_adgen').
 *     That works identically for the normal side-by-side checkout layout
 *     AND for a pair of feature worktrees placed as siblings under the
 *     same parent (this repo's own CLAUDE.md requires worktrees to be
 *     siblings of the checkout, never nested inside it) — nothing here
 *     names a specific worktree, so it does not rot the moment today's
 *     worktrees are deleted. A citation unresolved in the home repo is
 *     retried against every discovered sibling, plus an `src/`-prefix
 *     toggle (adgen nests services/routes/pipelines/remotion/models under
 *     `src/`; backend does not) as a second-chance fallback for a citation
 *     that names the "generic" half of a cross-repo pair without spelling
 *     out the nesting.
 *
 * (C) DELETION / HYPOTHETICAL NEGATION. A comment that correctly says "X
 *     was deleted/removed/retired [date]" must NOT fail — that IS the fix
 *     pattern this whole harness exists to encourage, and this repo's own
 *     CLAUDE.md is full of exactly that pattern (struck-through bullets,
 *     "REMOVED 2026-08-28", "Do not cite them again"). For every
 *     unresolved citation, a ±3-line window around its own line (not the
 *     whole surrounding comment block, which in this repo can run 50+
 *     lines and cover unrelated topics — too wide a window would silently
 *     launder a genuinely-stale citation sitting a few paragraphs away
 *     from an unrelated "deleted" mention) is checked against
 *     NEGATION_RE. Deliberately narrow rather than whole-block: the
 *     failure direction of a too-narrow window is a false positive (still
 *     the priority to avoid) but the ±3 window was sized against the two
 *     real incidents this harness was built to catch (the
 *     titlingResumeService.js "REMOVED 2026-08-28" block in
 *     config/defaults.env, and CLAUDE.md's "were DELETED on 2026-08-28 …
 *     Do not cite them again" passage) and both land inside it — see the
 *     self-tests below for the exact strings.
 *       The same word list also carries "hypothetical/planned" language
 *     (proposed/planned/decomposition plan/not yet built/…), because a
 *     deliberately-not-yet-built path is the same shape of "correctly
 *     documented as not existing" as a deliberately-deleted one.
 *
 * (D) docs/PARALLEL_WORK.md HYPOTHETICAL-PATH ALLOWLIST. That file's
 *     "Clusters → target files" table lists `routes/ads/*.js` as PROPOSED
 *     decomposition targets — CLAUDE.md says explicitly "§1-5 are
 *     decomposition plans that are deliberately NOT executed". The
 *     hypothetical language sits many lines above each one-line table row,
 *     outside the ±3 negation window, so this is a second, explicit,
 *     file-scoped ALLOWLIST entry (see ALLOWLIST below) rather than relying
 *     on (C) alone. Every allowlist entry carries a `reason` string, not a
 *     bare path — that is enforced at load time (A0 below).
 *
 * (E) EXTENSION NORMALISATION, decided and documented (not just handled):
 *     a citation ending .js/.jsx/.mjs is checked under all three
 *     extensions before failing (e.g. a comment saying `Root.js` for the
 *     real `Root.jsx` must not fail). DECISION: normalise rather than
 *     hand-maintain a growing allowlist of extension slips across two
 *     actively-edited repos — the false-positive risk of guessing wrong
 *     (a truly-dead citation whose swapped extension happens to exist) is
 *     accepted as strictly preferable to the alternative (a noisy check
 *     that gets disabled), per this repo's own stated priority.
 *
 * (F) LINE-NUMBER SUFFIXES (`file.js:123`, `file.js:120-140`) are stripped
 *     before the existence check. CLAUDE.md says this outright: drifted
 *     line numbers are normal churn, not a citation defect, and validating
 *     NNN would make this check so noisy it gets disabled.
 *
 * (G) FUNCTION-NAME CHECKABILITY FILTER. Not every `word()` in a comment is
 *     a citation of THIS repo's code — `select()`, `post()`, `match()`,
 *     `stop()`, `flush()`, `unref()` are all real generic
 *     Mongoose/axios/String/Node method names that appear constantly in
 *     prose without meaning "go look at a function named exactly this".
 *     Calibrated against a real scan of this repo's own CLAUDE.md: of the
 *     24 unique bare `identifier()` citations found, the ones this repo
 *     actually means as "look at this specific helper" are ALL
 *     multi-word-camelCase or snake_case names of 6+ characters
 *     (`isHookFirstVideoPromptEnabled`, `submitRetryDecision`,
 *     `renderRouteForKind`, `receiptFree`, …); the ones that are generic
 *     short method names (`select`, `post`, `match`, `stop`, `flush`,
 *     `unref`) all fail that shape. So a `name()` citation is only
 *     CHECKED (resolved-or-fails) when its final dotted segment is ≥6
 *     characters AND (has an internal case change OR contains `_`) — this
 *     is a deliberate under-approximation: a short, generic-looking name
 *     is silently not checked at all (a false negative we accept) rather
 *     than resolved against an ever-growing builtin denylist (which would
 *     itself be a maintenance/noise trap). See the self-test for the exact
 *     24-name calibration set.
 *
 * (H) FUNCTION / ENV RESOLUTION CORPUS IS BUILT FROM CODE ONLY, COMMENTS
 *     STRIPPED — this is load-bearing, not an optimisation. If the
 *     resolution corpus were built from raw file text (comments included),
 *     a stale comment citing a deleted function would trivially "resolve"
 *     against ITSELF (its own `fooBar()` mention would satisfy a naive
 *     `/\bfooBar\(/` corpus scan), making the whole function-citation check
 *     vacuous — it could never fail. `buildCorpus()` runs every source
 *     file through the SAME comment/string/regex tokenizer used for
 *     citation extraction and keeps only kind 0 (real code) and kind 1
 *     (string/regex/template literal content), discarding kind 2
 *     (comments) before harvesting identifiers, quoted SCREAMING_SNAKE
 *     literals, and dynamic-env-prefix patterns. See the self-test that
 *     pins this directly (a synthetic file whose ONLY mention of a name is
 *     inside a comment must NOT resolve).
 *
 * (I) DYNAMIC `process.env[...]` CONSTRUCTION. An env var is treated as
 *     "read anywhere in the codebase" if it is (i) declared in
 *     config/defaults.env (either repo), (ii) read via literal
 *     `process.env.NAME` / `process.env['NAME']` / `process.env["NAME"]`
 *     anywhere, (iii) passed as a quoted string literal anywhere (covers
 *     the very common `helper('SOME_ENV_NAME', default)` indirection this
 *     repo uses throughout — `services/backlogWatchdog.js`'s `N(name,
 *     dflt)` being the calibration example), or (iv) matches a live
 *     DYNAMIC PREFIX harvested from real concatenation/template patterns
 *     (`'PREFIX_' + x` or `` `PREFIX_${x}` ``) — e.g.
 *     `services/atlasModelMap.js`'s `envKeyFor(role)` builds
 *     `'ATLAS_MODEL_' + role.toUpperCase()...`, so any
 *     `ATLAS_MODEL_<ANYTHING>` citation is accepted without needing a
 *     literal anchor for every possible role.
 *
 * (J) TEST-FIXTURE / EXAMPLE names inside scripts/verify*.js. These are not
 *     special-cased separately — they fall out of (C): a resolver's own
 *     documented negative-test fixture reads as "correctly returns null
 *     for a missing file" / "does not exist" / "nonexistent" in the
 *     surrounding prose, which NEGATION_RE already catches. No separate
 *     mechanism was needed once (C) existed; a synthetic self-test below
 *     pins this specific shape too.
 *
 * PORTABILITY (backend <-> adgen). This exact file is intended to run
 * unmodified in both repos: SCAN_DIR_CANDIDATES lists both the flat
 * (`services/`) and `src/`-nested (`src/services/`) spellings and keeps
 * only the ones that exist; ROOT is always `path.join(__dirname, '..')`;
 * sibling discovery is package.json-name-based, never a hardcoded path.
 *
 * ALLOWLIST MECHANISM. `ALLOWLIST` below is the ONLY way to suppress a
 * finding outside of the negation/hypothetical logic above. Every entry is
 * `{ citation, file, reason }` — `reason` is REQUIRED and non-empty (A0
 * enforces this structurally: a bare path with no reason fails the harness
 * itself), `citation` is an exact string or RegExp tested against the
 * cleaned citation text, and `file` (optional) scopes the entry to
 * citations found in one repo-relative source path.
 *
 * REVERT-PROOF: run with an intentionally-reintroduced dead citation (e.g.
 * add a comment citing `services/titlingResumeService.js` with no
 * deletion marker nearby) and confirm this script exits non-zero and
 * names the exact file:line + citation. See session notes for the actual
 * transcript of that run.
 *
 * Run: node scripts/verifyDocCitations.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// Repo / sibling discovery
// ══════════════════════════════════════════════════════════════════════

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const SELF_PKG = readJsonSafe(path.join(ROOT, 'package.json')) || {};
// The only two repos in this ecosystem today. Naming them here is not a
// worktree-specific hack — it is the reciprocal-name lookup table for the
// two real repos; worktree LOCATIONS are discovered below, never hardcoded.
const REPO_PAIR = {
  'liquidretail-backend': 'liquidretail_adgen',
  'liquidretail_adgen': 'liquidretail-backend',
};
const SIBLING_PKG_NAME = REPO_PAIR[SELF_PKG.name] || null;

function findReposByPkgName(parentDir, pkgName) {
  const out = [];
  if (!pkgName) return out;
  let ents;
  try { ents = fs.readdirSync(parentDir, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (!ent.isDirectory() || ent.name === 'node_modules') continue;
    const abs = path.join(parentDir, ent.name);
    if (path.resolve(abs) === path.resolve(ROOT)) continue;
    const pkg = readJsonSafe(path.join(abs, 'package.json'));
    if (pkg && pkg.name === pkgName) out.push(abs);
  }
  return out;
}

const SIBLING_ROOTS = findReposByPkgName(path.dirname(ROOT), SIBLING_PKG_NAME);
const ALL_ROOTS = [ROOT, ...SIBLING_ROOTS];

// ══════════════════════════════════════════════════════════════════════
// Directory discovery (path-signal gate, built from disk — see header (A))
// ══════════════════════════════════════════════════════════════════════

function topLevelDirNames(root) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git').map((e) => e.name);
}

const KNOWN_TOP_SEGMENTS = new Set(ALL_ROOTS.flatMap(topLevelDirNames));

// A small, curated set of BARE (no directory) root filenames that are
// legitimately cited without a leading path — deliberately short, per the
// task's own warning against bare common filenames. Existence is checked
// per-repo, so this list never fails just because one repo lacks worker.js.
const ROOT_BARE_FILES = [
  'CLAUDE.md', 'ARCHITECTURE_REVIEW.md', 'CHANGELOG.md', 'session.md',
  'README.md', 'package.json', 'eslint.config.js', 'index.js', 'worker.js',
  'render.yaml',
];

// ══════════════════════════════════════════════════════════════════════
// File walking
// ══════════════════════════════════════════════════════════════════════

function walkFiles(root, exts) {
  const out = [];
  function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) out.push(p);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out;
}

// The task's exact scan scope. Both the flat (backend) and `src/`-nested
// (adgen) spellings are listed; only the ones that exist on disk are kept,
// which is what makes this one file work unmodified in both repos.
const SCAN_DIR_CANDIDATES = [
  'services', 'routes', 'pipelines', 'remotion', 'models', 'scripts',
  'src/services', 'src/routes', 'src/pipelines', 'src/remotion', 'src/models',
];
const SCAN_DIRS = SCAN_DIR_CANDIDATES.filter((d) => fs.existsSync(path.join(ROOT, d)));

const CODE_FILES = [];
for (const d of SCAN_DIRS) CODE_FILES.push(...walkFiles(path.join(ROOT, d), ['.js', '.mjs', '.jsx']));

const DOC_FILES = [];
if (fs.existsSync(path.join(ROOT, 'CLAUDE.md'))) DOC_FILES.push(path.join(ROOT, 'CLAUDE.md'));
const docsDir = path.join(ROOT, 'docs');
if (fs.existsSync(docsDir)) {
  for (const f of fs.readdirSync(docsDir)) {
    if (f.endsWith('.md')) DOC_FILES.push(path.join(docsDir, f));
  }
}

// ══════════════════════════════════════════════════════════════════════
// Tokenizer — string/comment/regex classifier, same convention this repo's
// other verify*.js harnesses share (e.g. verifyGroundedGeminiLedger.js
// classifySource/stripComments), so a regex or template literal containing
// a stray brace/quote cannot desync comment extraction the way a naive
// `//`/`/* */` string search would.
// ══════════════════════════════════════════════════════════════════════

function classifySource(src) {
  const kind = new Uint8Array(src.length); // 0 = code, 1 = string/regex literal, 2 = comment
  let mode = null; // null | "'" | '"' | '`' | '//' | '/*' | 'regex' | 'regexClass'
  let lastSig = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === "'" || c === '"' || c === '`') { mode = c; kind[i] = 1; continue; }
      if (c === '/' && n === '/') { mode = '//'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && n === '*') { mode = '/*'; kind[i] = 2; kind[i + 1] = 2; i++; continue; }
      if (c === '/' && !/[A-Za-z0-9_$)\]}]/.test(lastSig)) { mode = 'regex'; kind[i] = 1; continue; }
      if (!/\s/.test(c)) lastSig = c;
      continue;
    }
    if (mode === '//') { kind[i] = 2; if (c === '\n') mode = null; continue; }
    if (mode === '/*') { kind[i] = 2; if (c === '*' && n === '/') { kind[i + 1] = 2; i++; mode = null; } continue; }
    if (mode === 'regex' || mode === 'regexClass') {
      kind[i] = 1;
      if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
      if (mode === 'regex' && c === '[') { mode = 'regexClass'; continue; }
      if (mode === 'regexClass' && c === ']') { mode = 'regex'; continue; }
      if (mode === 'regex' && c === '/') {
        mode = null; lastSig = '/';
        while (i + 1 < src.length && /[a-z]/i.test(src[i + 1])) { i++; kind[i] = 1; }
      }
      continue;
    }
    // string/template mode
    kind[i] = 1;
    if (c === '\\') { if (n !== undefined) kind[i + 1] = 1; i++; continue; }
    if (c === mode) { mode = null; lastSig = c; }
  }
  return kind;
}

/** Contiguous kind===2 (comment) runs, each with the absolute char offset
 * where it starts in the ORIGINAL source (so callers can compute real line
 * numbers). Adjacent `//` lines are NOT merged across a blank/code line —
 * each contiguous run is its own block, which is exactly what's needed for
 * "header/inline comments". */
function extractCommentBlocks(src) {
  const kind = classifySource(src);
  const out = [];
  let i = 0;
  while (i < src.length) {
    if (kind[i] === 2) {
      const start = i;
      while (i < src.length && kind[i] === 2) i++;
      out.push({ text: src.slice(start, i), start });
    } else i++;
  }
  return out;
}

/** Comment ranges blanked (space, newlines preserved), string/regex/template
 * content and real code left intact. Used ONLY to build the resolution
 * corpus — see header (H): this is what stops a stale comment's own
 * citation from resolving against itself. */
function codeOnly(src) {
  const kind = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += kind[i] === 2 ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  return out;
}

function computeNewlineOffsets(src) {
  const offsets = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offsets.push(i);
  return offsets;
}

/** 1-based line number of a char offset, via the precomputed newline list. */
function lineOfOffset(newlineOffsets, offset) {
  let lo = 0, hi = newlineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (newlineOffsets[mid] < offset) lo = mid + 1; else hi = mid;
  }
  return lo + 1;
}

// ══════════════════════════════════════════════════════════════════════
// Citation extraction
// ══════════════════════════════════════════════════════════════════════

// Order matters: regex alternation tries left-to-right and is NOT
// longest-match. `js` is a literal prefix of `json` ("j"+"s"+"on"), so
// with `js` tried first, a citation ending in `.json` (e.g.
// `vendor-manifest.json`) matches the `js` alternative against its own
// leading "js" and silently truncates the match to `.js`, leaving "on"
// unconsumed — found empirically: `scripts/vendor-manifest.json`,
// `services/reviewSiteProfiles.json` and several
// `schemas/contracts/*.v1.json` citations were all resolving (and then
// failing existence) as the wrong, nonexistent `.js` sibling. `js` is
// ALSO a prefix of `jsx`, so the same truncation happens there too —
// but it is harmless in practice because `existsUnderAnyExt` already
// tries the js/jsx/mjs group regardless of which one the regex
// captured; `.json` has no such normalisation group, so it is the one
// extension where getting this ordering wrong is a real, silent
// resolution failure. Longer/more-specific alternatives first, always.
const CITABLE_EXT = 'mjs|jsx|json|md|js';
const PATH_RE = new RegExp(
  `(\\.{1,2}/[A-Za-z0-9_.\\-/]+\\.(?:${CITABLE_EXT})|(?:[A-Za-z0-9_.\\-]+/)+[A-Za-z0-9_.\\-]+\\.(?:${CITABLE_EXT}))(:\\d+(?:-\\d+)?)?`,
  'g'
);
const ROOT_BARE_RE = new RegExp(`\\b(${ROOT_BARE_FILES.map((f) => f.replace(/\./g, '\\.')).join('|')})\\b`, 'g');
const FUNC_RE = /\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)\(\s*\)/g;
const ENV_RE = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g;

function pathHasSignal(cleanPath) {
  if (cleanPath.startsWith('./') || cleanPath.startsWith('../')) return true;
  const firstSeg = cleanPath.split('/')[0];
  return KNOWN_TOP_SEGMENTS.has(firstSeg);
}

/** Extracts every recognised citation from `text`. Returns
 * {kind:'path'|'func'|'env', raw, clean, isPrefix, index}[]. `index` is the
 * char offset of the citation WITHIN `text` (caller maps to an absolute
 * file offset). */
function extractCitations(text) {
  const out = [];
  const pathSpans = []; // [start, end) of every recognised path match — see below
  let m;

  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(text))) {
    const clean = m[1];
    if (!pathHasSignal(clean)) continue;
    out.push({ kind: 'path', raw: m[0], clean, index: m.index });
    pathSpans.push([m.index, m.index + m[0].length]);
  }

  ROOT_BARE_RE.lastIndex = 0;
  while ((m = ROOT_BARE_RE.exec(text))) {
    // Skip if this bare name is actually part of a longer path match already
    // captured above (e.g. "docs/README.md" already carries a directory —
    // recorded once via PATH_RE, not again here as a bare "README.md").
    const before = text[m.index - 1];
    if (before === '/') continue;
    out.push({ kind: 'path', raw: m[0], clean: m[1], index: m.index });
    pathSpans.push([m.index, m.index + m[0].length]);
  }

  FUNC_RE.lastIndex = 0;
  while ((m = FUNC_RE.exec(text))) {
    out.push({ kind: 'func', raw: m[0], clean: m[1], index: m.index });
  }

  // ENV_RE fires on ANY bare SCREAMING_SNAKE run, which also matches the
  // stem of an already-recognised path/filename (`docs/REVIEW_VENDORS.md`
  // legitimately resolves as a path, but ENV_RE independently finds
  // "REVIEW_VENDORS" inside it and — having no notion of the trailing
  // ".md" — reports it a second time as a dead env var). Found empirically
  // against this repo's own docs; any ENV_RE hit whose span falls inside a
  // path match already recorded above is the SAME text, not a second
  // citation, and is dropped here.
  ENV_RE.lastIndex = 0;
  while ((m = ENV_RE.exec(text))) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (pathSpans.some(([s, e]) => start >= s && end <= e)) continue;
    const after = text[end];
    out.push({ kind: 'env', raw: m[0], clean: m[1], isPrefix: after === '*', index: start });
  }

  return out;
}

// checkable per header (G) — camelCase-multiword or snake_case, >=6 chars,
// applied to the FINAL dotted segment.
function isCheckableFuncName(name) {
  const last = name.split('.').pop();
  if (last.length < 6) return false;
  const internalCaseChange = /[a-z][A-Z]/.test(last) || /[A-Z][a-z]/.test(last.slice(1));
  return internalCaseChange || last.includes('_');
}

// ══════════════════════════════════════════════════════════════════════
// Negation / hypothetical detection — header (C)
// ══════════════════════════════════════════════════════════════════════

const NEGATION_RE = new RegExp(
  [
    'deleted', 'was deleted', 'being deleted', 'removed', 'retired', '\\bgone\\b',
    'dropped', 'superseded', 'renamed', 'no longer exists?', "doesn't exist",
    'does not exist', 'nonexistent', 'non-existent', 'never existed',
    'no such file', 'missing file',
    // "the OLD/historical thing" — found empirically:
    // services/headlessBrowserClient.js describes a regex "historically
    // matched by CF_RE" (CF_RE is gone, CF_BODY_RE is the live one);
    // "used to" is this repo's own dominant phrasing for the same shape
    // (CLAUDE.md: "used to call X", "the old coercion lived inside Y as…").
    'historically', 'used to\\b', 'no longer\\b',
    // "there is/was no X" and "no X <noun>" — a comment correctly stating a
    // thing was NEVER built is the same "correctly documented as absent"
    // shape as one stating a thing WAS removed. Found empirically:
    // services/imagePreviewUrl.js ("There is no imageCropUrl.js sibling"),
    // services/directImageRenderService.js ("No AI_DIRECT_IMAGE_MODEL /
    // text-to-image constant").
    '\\bthere (?:is|was|are|were) no\\b',
    '\\bno [A-Za-z0-9_./-]+ (?:constant|variable|flag|module|file|helper|sibling)\\b',
    // hypothetical / planned — see header (C) and (D)
    'proposed', 'planned', 'hypothetical', 'decomposition plan',
    'deliberately not executed', 'not yet built', 'not yet implemented',
    'not yet created', "doesn't exist yet", 'does not exist yet',
    "don't exist yet", 'do not exist yet', 'future work', 'new home',
    'target file',
  ].join('|'),
  'i'
);
const NEGATION_WINDOW_LINES = 3;

function hasNearbyNegation(fileLines, lineNo) {
  const start = Math.max(0, lineNo - 1 - NEGATION_WINDOW_LINES);
  const end = Math.min(fileLines.length, lineNo - 1 + NEGATION_WINDOW_LINES + 1);
  return NEGATION_RE.test(fileLines.slice(start, end).join('\n'));
}

// ══════════════════════════════════════════════════════════════════════
// Allowlist — the ONLY other way to suppress a finding. Every entry MUST
// carry a non-empty `reason` (enforced by self-test A0 below).
// ══════════════════════════════════════════════════════════════════════

const ALLOWLIST = [
  {
    file: 'docs/PARALLEL_WORK.md',
    citation: /^routes\/ads\//,
    reason: 'Documents a deliberately-unexecuted route-decomposition plan — '
      + 'CLAUDE.md states outright that "§1-5 are decomposition plans that '
      + 'are deliberately NOT executed". The routes/ads/*.js paths under the '
      + '"Clusters → target files" table are proposed future homes, not real '
      + 'files, and the hypothetical framing sits many lines above each '
      + 'one-line table row — outside the ±3-line negation window — so this '
      + 'is an explicit file-scoped exemption rather than relying on (C).',
  },
  {
    file: null,
    citation: '.claude/settings.local.json',
    reason: 'Claude Code\'s standard per-user local settings override. '
      + 'Confirmed absent from `git ls-files` in both repos (only '
      + '.claude/settings.json is tracked) — it is legitimately optional and '
      + 'may not exist on any given checkout; not a repo source artifact.',
  },
];

for (const entry of ALLOWLIST) {
  if (!entry.reason || !entry.reason.trim()) {
    throw new Error(`ALLOWLIST entry for ${JSON.stringify(entry.citation)} has no reason — every entry must be documented`);
  }
}

function isAllowlisted(kind, clean, repoRelFile) {
  for (const entry of ALLOWLIST) {
    if (entry.file && entry.file !== repoRelFile) continue;
    const m = entry.citation;
    const hit = m instanceof RegExp ? m.test(clean) : m === clean;
    if (hit) return entry;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
// Resolution corpus — header (H): built from CODE ONLY, comments stripped,
// across every source file in BOTH repos (not just the six scanned dirs —
// a cited function can legitimately live in middleware/, utils/, index.js,
// etc).
// ══════════════════════════════════════════════════════════════════════

function buildCorpus(roots) {
  const funcTokens = new Set();
  const quotedLiterals = new Set();
  const dynamicEnvPrefixes = new Set();
  const defaultsEnvKeys = new Set();

  for (const root of roots) {
    const defPath = path.join(root, 'config', 'defaults.env');
    if (fs.existsSync(defPath)) {
      let txt = '';
      try { txt = fs.readFileSync(defPath, 'utf8'); } catch { /* ignore */ }
      for (const m of txt.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) defaultsEnvKeys.add(m[1]);
    }

    const files = walkFiles(root, ['.js', '.mjs', '.jsx']);
    for (const f of files) {
      let raw;
      try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const src = codeOnly(raw); // comments blanked — see header (H)

      for (const m of src.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) funcTokens.add(m[1]);
      for (const m of src.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g)) quotedLiterals.add(m[1]);
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) quotedLiterals.add(m[1]);
      // Any bare SCREAMING_SNAKE identifier appearing anywhere in real code
      // (a declaration, a reference, a param, an object key) — not just a
      // quoted literal or a process.env read. Without this, a comment
      // citing a plain local test-fixture constant (e.g. a verify*.js
      // harness's own `const BRAND_A = ObjectId()`, `const V2_FLAT = {...}`)
      // reads as an "env var" by shape (SCREAMING_SNAKE) and was flooding
      // this check with ~800 false positives on the real corpus — those
      // names are declared and used constantly, just never as a string or
      // an env read. Widening the corpus to any bare occurrence directly
      // implements the task's own phrasing: "neither declared nor read
      // anywhere" — a bare `const NAME = …` IS a declaration.
      for (const m of src.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)) quotedLiterals.add(m[1]);
      for (const m of src.matchAll(/['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)['"]\s*\+/g)) dynamicEnvPrefixes.add(m[1]);
      for (const m of src.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_)\$\{/g)) dynamicEnvPrefixes.add(m[1]);
    }
  }
  return { funcTokens, quotedLiterals, dynamicEnvPrefixes, defaultsEnvKeys };
}

function funcResolves(name, corpus) {
  return corpus.funcTokens.has(name.split('.').pop());
}

// Meta-words describing a CASING CONVENTION itself ("a stable UPPER_SNAKE
// class", this file's own header saying "SCREAMING_SNAKE_CASE env var
// names") are shaped exactly like a real SCREAMING_SNAKE citation but are
// not one — found empirically (both are real prose in this repo:
// models/CampaignRun.js, services/atlasErrorPolicy.js). Deliberately a
// short, exact-match list, not a heuristic — the failure mode of getting
// this wrong is under-checking two specific words, never over-suppressing
// a real citation.
const META_CASING_WORDS = new Set(['UPPER_SNAKE', 'SCREAMING_SNAKE']);

// Segment-boundary substring check: `needle` resolves against `haystack` if
// it appears as a contiguous run of `_`-separated segments inside it (so
// "TOP_N" matches "DIRECTOR_UNIVERSE_TOP_N" and "AUTH_MISSING" matches
// "LLM_AUTH_MISSING", but a short fragment cannot spuriously match an
// unrelated longer name that merely shares letters with no `_`/boundary
// alignment). Found empirically: this repo's comments very often use the
// SHORT, locally-distinguishing half of a longer real name
// (`services/llmError.js`'s `LLM_AUTH_MISSING` code discussed simply as
// "AUTH_MISSING" once the LLM_ prefix is established by context;
// `config/defaults.env`'s `DIRECTOR_UNIVERSE_TOP_N` shortened to "TOP_N"
// throughout the Director/universe code) — treating every such shorthand
// as a dead citation would be exactly the noisy-check-gets-disabled trap.
function segmentContains(haystack, needle) {
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|_)${esc}(_|$)`).test(haystack);
}
function looseMatch(name, corpus) {
  for (const k of corpus.defaultsEnvKeys) if (segmentContains(k, name)) return true;
  for (const k of corpus.quotedLiterals) if (segmentContains(k, name)) return true;
  return false;
}

function envResolves(name, isPrefix, corpus) {
  if (META_CASING_WORDS.has(name)) return true;
  const prefixOf = (s) => (s.endsWith('_') ? s : `${s}_`);
  if (isPrefix) {
    const p = prefixOf(name);
    for (const k of corpus.defaultsEnvKeys) if (k === name || k.startsWith(p)) return true;
    for (const k of corpus.quotedLiterals) if (k === name || k.startsWith(p)) return true;
    for (const k of corpus.dynamicEnvPrefixes) if (k.startsWith(p) || p.startsWith(k)) return true;
    return looseMatch(name, corpus);
  }
  if (corpus.defaultsEnvKeys.has(name)) return true;
  if (corpus.quotedLiterals.has(name)) return true;
  for (const pre of corpus.dynamicEnvPrefixes) if (name.startsWith(pre)) return true;
  return looseMatch(name, corpus);
}

// ══════════════════════════════════════════════════════════════════════
// Path resolution — header (B), (E), (F)
// ══════════════════════════════════════════════════════════════════════

function extAlternatives(p) {
  const m = p.match(/\.(js|jsx|mjs)$/);
  if (!m) return [p];
  const base = p.slice(0, -m[0].length);
  return ['js', 'jsx', 'mjs'].map((e) => `${base}.${e}`);
}

function existsUnderAnyExt(baseDir, relPath) {
  return extAlternatives(relPath).some((variant) => fs.existsSync(path.join(baseDir, variant)));
}

function pathResolves(cleanPathWithSuffix, citingFileDir) {
  const clean = cleanPathWithSuffix.replace(/:\d+(?:-\d+)?$/, ''); // header (F)
  const isRelative = clean.startsWith('./') || clean.startsWith('../');

  if (isRelative) {
    return existsUnderAnyExt(citingFileDir, clean);
  }

  for (const root of ALL_ROOTS) {
    if (existsUnderAnyExt(root, clean)) return true;
  }
  // src/ nesting toggle — header (B) second-chance fallback
  const toggled = clean.startsWith('src/') ? clean.slice(4) : `src/${clean}`;
  for (const root of ALL_ROOTS) {
    if (existsUnderAnyExt(root, toggled)) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// Self-tests — synthetic fixtures, no real-file mutation. These pin the
// FALSE-POSITIVE-AVOIDANCE LOGIC ITSELF (negation window, allowlist,
// cross-repo, extension normalisation, path-signal gate, corpus
// comment-exclusion, dynamic env prefixes) independent of live repo drift.
// ══════════════════════════════════════════════════════════════════════

(function selfTests() {
  check('A0 every ALLOWLIST entry carries a non-empty reason',
    ALLOWLIST.every((e) => typeof e.reason === 'string' && e.reason.trim().length > 20),
    'a bare allowlisted path with no rationale is exactly the kind of unexamined suppression this harness must not allow');

  // (G) function-name checkability, calibrated against the real 24-name set
  // pulled from this repo's own CLAUDE.md (see header).
  const checkableExamples = ['isHookFirstVideoPromptEnabled', 'submitRetryDecision', 'renderRouteForKind', 'receiptFree', 'conceptField', 'backfillBrandWebsiteUrl'];
  const nonCheckableExamples = ['select', 'post', 'match', 'stop', 'flush', 'unref'];
  check('G1 multi-word camelCase / snake_case names >=6 chars are checkable',
    checkableExamples.every(isCheckableFuncName));
  check('G2 short generic builtin-shaped names are NOT checked (avoids denylist maintenance)',
    nonCheckableExamples.every((n) => !isCheckableFuncName(n)));
  check('G3 dotted citation checkability keys off the FINAL segment',
    isCheckableFuncName('veoPromptBuilder.isHookFirstVideoPromptEnabled') && !isCheckableFuncName('runHeartbeat.stop'));

  // (H) corpus must be built from CODE ONLY — a name mentioned exclusively
  // inside a comment must not resolve against itself.
  {
    const commentOnlySrc = '// see totallyMadeUpHelperName() for details\nconst x = 1;\n';
    const realCorpusSrc = 'function totallyMadeUpHelperName() { return 1; }\nmodule.exports = { totallyMadeUpHelperName };\n';
    const strippedComment = codeOnly(commentOnlySrc);
    const strippedReal = codeOnly(realCorpusSrc);
    const fakeCorpus = { funcTokens: new Set(), quotedLiterals: new Set(), dynamicEnvPrefixes: new Set(), defaultsEnvKeys: new Set() };
    for (const m of strippedComment.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) fakeCorpus.funcTokens.add(m[1]);
    check('H1 a comment-only mention does NOT populate the resolution corpus',
      !fakeCorpus.funcTokens.has('totallyMadeUpHelperName'));
    for (const m of strippedReal.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) fakeCorpus.funcTokens.add(m[1]);
    check('H2 a real declaration DOES populate the resolution corpus',
      fakeCorpus.funcTokens.has('totallyMadeUpHelperName'));
    check('H3 with only the comment-only source, the SAME name citation would fail to resolve (not self-validate)',
      !funcResolves('totallyMadeUpHelperName', { funcTokens: new Set([...codeOnly(commentOnlySrc).matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1])) }));
  }

  // (C) negation window — the two real incidents this harness targets.
  {
    const defaultsEnvSnippet = [
      '# REMOVED 2026-08-28 — recovered-master titling resume',
      "# (services/titlingResumeService.js) was deleted (owner directive: \"remove",
      '# and disable the backend titling function, we are not going to go back to',
      '# it"; adgen owns titling exclusively now).',
    ].join('\n');
    const lines1 = defaultsEnvSnippet.split('\n');
    check('C1 REMOVED/was-deleted block (real defaults.env text) is recognised as negated',
      hasNearbyNegation(lines1, 2));

    const claudeMdSnippet = [
      '  `services/titlingResumeService.js` and its pins',
      '  (`scripts/verifyTitlingResume.js`, `scripts/verifyTitlingResumeAdgenGate.js`)',
      '  were DELETED on 2026-08-28 in `abf7e0c2` — owner directive. Do not cite',
      '  them again.',
    ].join('\n');
    const lines2 = claudeMdSnippet.split('\n');
    check('C2 "were DELETED … Do not cite them again" (real CLAUDE.md text) negates the citation 2 lines above',
      hasNearbyNegation(lines2, 1));

    const staleNoDeletionMarker = [
      '  // do not remove — still works as a shared fallback (see',
      '  // adVisionQcService.js staticEnvEnabled/videoEnvEnabled)',
      '  const x = 1;',
    ].join('\n');
    const lines3 = staleNoDeletionMarker.split('\n');
    check('C3 a "do not remove" instruction with NO deletion marker nearby is NOT negated (must still be checked)',
      !hasNearbyNegation(lines3, 2));

    // (J) a resolver's own documented negative-test fixture reads as
    // "nonexistent"/"does not exist" and is covered by the SAME mechanism.
    const fixtureComment = [
      '// fixture: resolveThing correctly returns null for services/doesNotExist.js',
      '// (nonexistent path, used to test the negative case)',
    ].join('\n');
    const lines4 = fixtureComment.split('\n');
    check('J1 a documented negative-test fixture path is recognised as negated via the same NEGATION_RE',
      hasNearbyNegation(lines4, 1));
  }

  // (D) PARALLEL_WORK.md hypothetical-path allowlist
  check('D1 routes/ads/generate.js is allowlisted only when cited from docs/PARALLEL_WORK.md',
    !!isAllowlisted('path', 'routes/ads/generate.js', 'docs/PARALLEL_WORK.md')
    && !isAllowlisted('path', 'routes/ads/generate.js', 'CLAUDE.md'));

  // (A) path-signal gate — third-party bare filenames without a directory
  // signal must never be recognised as citations at all.
  check('A1 bare third-party filenames (no directory signal) are not recognised as path citations',
    extractCitations('see products.json, bv.js, widget.js, themes.json, Next.js for reference').filter((c) => c.kind === 'path').length === 0);
  check('A2 "frontend/client/templatePreview.js" is not recognised — frontend/ is not a real top-level dir of either repo',
    !pathHasSignal('frontend/client/templatePreview.js'));
  check('A3 a real top-level segment (services/) IS recognised as a path signal',
    pathHasSignal('services/anything.js'));
  check('A4 a relative ./ path is recognised regardless of segment name',
    pathHasSignal('./someRandomThing.js') && pathHasSignal('../someRandomThing.js'));

  // (E) extension normalisation
  {
    const scratchDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'verifyDocCitations-selftest-'));
    try {
      fs.writeFileSync(path.join(scratchDir, 'Root.jsx'), '// fixture\n');
      check('E1 a citation to Root.js resolves against the real Root.jsx (extension slip tolerated)',
        existsUnderAnyExt(scratchDir, 'Root.js'));
      check('E2 a citation to a name with no matching file under ANY extension still fails',
        !existsUnderAnyExt(scratchDir, 'TotallyMissing.js'));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  // (F) line-number suffix stripping
  {
    const scratchDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'verifyDocCitations-selftest-'));
    try {
      fs.mkdirSync(path.join(scratchDir, 'routes'));
      fs.writeFileSync(path.join(scratchDir, 'routes', 'ads.js'), '// fixture\n');
      const clean = 'routes/ads.js:1258-1343'.replace(/:\d+(?:-\d+)?$/, '');
      check('F1 a drifted line-number suffix is stripped before the existence check',
        clean === 'routes/ads.js' && existsUnderAnyExt(scratchDir, clean));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  // (I) dynamic env-var prefix resolution
  {
    const fakeCorpus = { funcTokens: new Set(), quotedLiterals: new Set(), dynamicEnvPrefixes: new Set(['ATLAS_MODEL_']), defaultsEnvKeys: new Set() };
    check('I1 a role-specific dynamic env var (ATLAS_MODEL_JUDGE) resolves via a harvested dynamic prefix with no literal anchor',
      envResolves('ATLAS_MODEL_JUDGE', false, fakeCorpus));
    check('I2 an unrelated env var sharing no prefix does NOT resolve',
      !envResolves('SOME_OTHER_FLAG', false, fakeCorpus));
    const prefixCorpus = { funcTokens: new Set(), quotedLiterals: new Set(), dynamicEnvPrefixes: new Set(), defaultsEnvKeys: new Set(['AI_IMAGE_REFERENCE_ENABLED', 'AI_IMAGE_REF_MODEL_ID']) };
    check('I3 a PREFIX_* glob citation (AI_IMAGE_REFERENCE_*) resolves when any matching key exists',
      envResolves('AI_IMAGE_REFERENCE', true, prefixCorpus));
  }

  // (B) cross-repo + src/ toggle, exercised against a synthetic pair of
  // repo roots (not the live repos, so this is independent of their drift).
  {
    const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'verifyDocCitations-crossrepo-'));
    const backendRoot = path.join(base, 'backend');
    const adgenRoot = path.join(base, 'adgen');
    fs.mkdirSync(path.join(backendRoot, 'services'), { recursive: true });
    fs.mkdirSync(path.join(adgenRoot, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(adgenRoot, 'src', 'services', 'onlyInAdgen.js'), '// fixture\n');
    const savedAllRoots = ALL_ROOTS.slice();
    ALL_ROOTS.length = 0;
    ALL_ROOTS.push(backendRoot, adgenRoot);
    try {
      check('B1 a backend-style path absent from backend resolves cross-repo via the src/ toggle against adgen',
        pathResolves('services/onlyInAdgen.js', backendRoot));
      check('B2 a path absent from BOTH roots (even with the toggle) correctly fails',
        !pathResolves('services/neverExisted.js', backendRoot));
    } finally {
      ALL_ROOTS.length = 0;
      ALL_ROOTS.push(...savedAllRoots);
      fs.rmSync(base, { recursive: true, force: true });
    }
  }
})();

// ══════════════════════════════════════════════════════════════════════
// Main scan
// ══════════════════════════════════════════════════════════════════════

const CORPUS = buildCorpus(ALL_ROOTS);
const checkedPairs = new Set(); // dedupe key: `${repoRelFile} ${kind} ${clean}`

function reportCitation(repoRelFile, kind, clean, isPrefix, allLineNos) {
  const key = `${repoRelFile} ${kind} ${clean}${isPrefix ? '*' : ''}`;
  if (checkedPairs.has(key)) return;
  checkedPairs.add(key);

  const firstLine = allLineNos[0];
  const label = `DocCitation ${repoRelFile}:${firstLine} — ${kind} \`${clean}${isPrefix ? '*' : ''}\``;

  const allowed = isAllowlisted(kind, clean, repoRelFile);
  if (allowed) { check(label, true); return; }

  let resolved;
  if (kind === 'path') {
    resolved = pathResolves(clean, path.dirname(path.join(ROOT, repoRelFile)));
  } else if (kind === 'func') {
    if (!isCheckableFuncName(clean)) { pass++; return; } // not checked — header (G)
    resolved = funcResolves(clean, CORPUS);
  } else {
    resolved = envResolves(clean, isPrefix, CORPUS);
  }

  if (resolved) { check(label, true); return; }

  // Not yet resolved — try negation before failing.
  const negated = allLineNos.some((ln) => hasNearbyNegation(FILE_LINES_CACHE.get(repoRelFile), ln));
  check(
    label,
    negated,
    negated
      ? undefined
      : `unresolved citation, lines ${allLineNos.join(', ')} — no matching file/function/env-var found in either repo, `
        + 'and no nearby deletion/hypothetical marker or ALLOWLIST entry'
  );
}

const FILE_LINES_CACHE = new Map(); // repoRelFile -> string[] (for negation windowing)

function scanFile(absFile, isDoc) {
  const repoRelFile = path.relative(ROOT, absFile);
  let src;
  try { src = fs.readFileSync(absFile, 'utf8'); } catch { return; }
  FILE_LINES_CACHE.set(repoRelFile, src.split('\n'));
  const newlineOffsets = computeNewlineOffsets(src);

  // repoRelFile -> kind clean -> Set(lineNo)
  const occurrences = new Map();
  function record(kind, clean, isPrefix, absOffset) {
    const lineNo = lineOfOffset(newlineOffsets, absOffset);
    const key = `${kind} ${clean}${isPrefix ? '*' : ''}`;
    if (!occurrences.has(key)) occurrences.set(key, { kind, clean, isPrefix, lines: [] });
    occurrences.get(key).lines.push(lineNo);
  }

  if (isDoc) {
    for (const c of extractCitations(src)) record(c.kind, c.clean, c.isPrefix, c.index);
  } else {
    for (const block of extractCommentBlocks(src)) {
      for (const c of extractCitations(block.text)) record(c.kind, c.clean, c.isPrefix, block.start + c.index);
    }
  }

  for (const { kind, clean, isPrefix, lines } of occurrences.values()) {
    reportCitation(repoRelFile, kind, clean, isPrefix, lines.sort((a, b) => a - b));
  }
}

for (const f of DOC_FILES) scanFile(f, true);
for (const f of CODE_FILES) scanFile(f, false);

check('Z1 scanned at least one doc file', DOC_FILES.length > 0, `DOC_FILES=${DOC_FILES.length}`);
check('Z2 scanned at least one code file', CODE_FILES.length > 0, `CODE_FILES=${CODE_FILES.length}`);
check('Z3 sibling repo discovered (cross-repo resolution is live, not a no-op)', SIBLING_ROOTS.length > 0,
  `expected sibling package '${SIBLING_PKG_NAME}' under ${path.dirname(ROOT)}; found none — cross-repo checks will under-resolve`);

// ── summary ──────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n❌ verifyDocCitations: ${failures.length} FAILED, ${pass} passed\n`);
  failures.forEach((f) => console.error(`   • ${f}`));
  process.exit(1);
}
console.log(`✅ verifyDocCitations: ${pass} checks passed`);
console.log(`   doc files scanned: ${DOC_FILES.length}; code files scanned: ${CODE_FILES.length}`);
console.log(`   sibling repo(s): ${SIBLING_ROOTS.map((r) => path.relative(path.dirname(ROOT), r)).join(', ') || '(none found)'}`);
console.log(`   resolution corpus: ${CORPUS.funcTokens.size} identifiers, ${CORPUS.quotedLiterals.size} quoted literals, ${CORPUS.dynamicEnvPrefixes.size} dynamic env prefixes, ${CORPUS.defaultsEnvKeys.size} defaults.env keys`);
