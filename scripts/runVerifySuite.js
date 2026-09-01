#!/usr/bin/env node
/**
 * runVerifySuite.js — parallel aggregate runner for scripts/verify*.{js,mjs}.
 *
 * WHY THIS EXISTS: with 6-10 concurrent Claude Code sessions on this repo,
 * every session re-ran every verify* harness ONE AT A TIME —
 *   for f in scripts/verify*.js; do node "$f" || echo "FAIL $f"; done
 * (the loop CLAUDE.md's header still documents) — taking 3-5 minutes,
 * repeated dozens of times a night, and that documented loop doesn't even
 * cover the *.mjs harnesses. This runs everything concurrently across a
 * small worker pool and reports the SAME pass/fail verdict per script: a
 * script's own process exit code (0 = pass, nonzero = fail). That is exactly
 * what the old loop already checked (`node "$f" ||`), so this is a strict
 * speedup, not a new definition of "pass".
 *
 * USAGE
 *   node scripts/runVerifySuite.js                    run every scripts/verify*.{js,mjs}
 *   node scripts/runVerifySuite.js --affected          run only scripts a diff plausibly touches
 *   node scripts/runVerifySuite.js --affected=<ref>    diff against <ref> instead of origin/main
 *   node scripts/runVerifySuite.js --concurrency=4      override the worker pool size
 *   node scripts/runVerifySuite.js --timeout=60000      override the per-script timeout (ms)
 *   node scripts/runVerifySuite.js --list               print the selected scripts, don't run them
 *   node scripts/runVerifySuite.js verifyFoo.js verifyBar.mjs   run only the scripts named
 *
 * Exit code 0 iff every selected script exited 0. Composes with a pre-push
 * hook or CI the same way the old loop did.
 *
 * PARALLEL-SAFETY, audited 2026-08-19, corrected 2026-08-19 (see below): no
 * scripts/verify* script talks to a live DB or network (the handful touching
 * mongoose/axios do so only for in-memory schema use, or say explicitly in
 * their own comments that they run with no MONGODB_URI). "Every script that
 * writes a temp file does it through fs.mkdtempSync, unique per process" was
 * asserted here before and was FALSE for three scripts — they mutated a real
 * shared repo file in place instead (see the file-mutation-race note below,
 * now fixed). It is true again as stated more precisely: every script that
 * writes a temp file now writes to a private path under os.tmpdir(), unique
 * per process (either via fs.mkdtempSync or a `${name}-${pid}-${Date.now()}`
 * suffixed filename) — never to a path any other verify script or the repo's
 * own tracked source resolves to. UNSAFE_FOR_PARALLEL below is the escape
 * hatch for a future script that breaks that assumption, or for a check with
 * its own real-timer margin too tight for an oversubscribed scheduler —
 * anything listed there runs alone, serially, after the parallel pool
 * drains.
 *
 * --affected IS A DEV-SPEED HEURISTIC, NOT THE GATE. It selects a verify
 * script if (a) the script itself changed, or (b) the script GENUINELY,
 * STATICALLY references the changed file — resolved by walking each script's
 * real require()/require.resolve()/readFileSync()/readFile()/import
 * dependency graph (transitively), not by grepping raw source text for a
 * path fragment.
 *
 * Revised 2026-08-19 (FIX 1/2): a prior version matched a changed file's
 * `dir/basename` fragment (e.g. "models/Ad") as a plain substring against
 * every script's raw source. That was unsound in both directions — it MISSED
 * real dependents whose only reference was a `path.join(__dirname, ...)`
 * call (the literal fragment never appears as contiguous text, e.g.
 * verifyRenderFailureRecord.js's `require(path.join(__dirname,'..','models',
 * 'Ad.js'))`), and it INVENTED false dependents from coincidental prefix
 * collisions (`models/Ad` matching inside `models/AdArchive...`, `routes/me`
 * matching inside the literal string `"routes/media.js filters ..."`) or
 * arbitrary text that was never a require target at all (`models/User`
 * matching the HTTP header string `"User-Agent"`). A wrong match is just as
 * damaging as a right one: it satisfies the "at least one match" check below
 * and hides a genuine zero. Resolving actual file paths through each script's
 * real dependency graph eliminates both failure modes at once, because a
 * match is now always a real resolved path, never a text coincidence.
 *
 * This still cannot know about indirect effects (e.g. changing a shared
 * helper's *behavior* without changing any path referencing it), and it
 * cannot fully resolve a genuinely dynamic require (e.g. `require(someVar)`)
 * — those are simply skipped rather than guessed at. So it still cannot know
 * a changed file has zero real dependents vs. an unresolvable gap — for
 * changed files under CORE_DIRS (the directories everything else routinely
 * requires) that end up matching NOTHING, computeAffected refuses to report
 * a clean "nothing selected": it fails loud and signals the caller to fall
 * back to the full suite instead. The runner's own file (this one) gets the
 * same treatment unconditionally when it changes — see computeAffected.
 * Run the full suite (no flags) before pushing non-trivial changes —
 * CLAUDE.md's own convention section already says so.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
const VERIFY_RE = /^verify.*\.(js|mjs)$/;

// Directories whose modules are routinely require()'d from all over the
// codebase (verified 2026-08-19: services/ and models/ alone account for
// 468 relative-require hits across scripts/verify*). If a changed file lives
// under one of these and the real dependency-graph resolution below still
// selects nothing, that is treated as "couldn't confidently resolve this" —
// never as proof the file has no dependents — and computeAffected falls back
// to the full suite rather than silently reporting a clean pass. Deliberately
// excludes scripts/ for verify*.{js,mjs} files specifically (those are
// already handled as "the script itself changed"); non-verify files directly
// under scripts/ (e.g. a shared scripts/lib/ helper) are still covered
// correctly because the real dependency graph finds any verify script that
// requires/reads them. The one file under scripts/ that graph resolution can
// NEVER cover is this runner itself — nothing requires it — so
// computeAffected has a separate, unconditional check for that (see below).
// Also deliberately excludes non-code dirs (docs/, public/, bin/,
// session.d/) whose edits genuinely have no verify-script dependents.
const CORE_DIRS = new Set(['models', 'routes', 'services', 'middleware', 'config', 'utils', 'pipelines', 'remotion', 'schemas']);

// Populated 2026-08-19 by stress-testing at --concurrency=16 (25-run baseline
// batch, this machine under heavy ambient load from other concurrent
// sessions — load average ~40-70 on 10 cores). Two DISTINCT failure classes
// were found, neither previously audited:
//
// (1) REAL FILE MUTATION RACE — FIXED 2026-08-19, no longer quarantined for
//     this reason. verifyVideoCostReconcile.js, verifyVideoTimeoutReconcile.js,
//     and verifyQuoteRotation.js each used a `withTempMutation`-shaped helper
//     that `fs.writeFileSync`d a mutated copy of a REAL repo file IN PLACE
//     (services/atlasVideoService.js for the first two;
//     services/productReviewsScrapeService.js, models/CatalogProduct.js,
//     services/quoteRotationService.js, and services/layoutInputService.js
//     for the third — the latter two were not caught by the original audit),
//     ran a check, then restored the original — all synchronously, but on
//     the SHARED checked-out file, not a private tmp copy. Two different
//     scripts mutated the SAME file (services/atlasVideoService.js), and
//     models/CatalogProduct.js is required by a large fraction of the suite:
//     any OTHER concurrently running process that read or fresh-required
//     that file during the brief write-check-restore window could observe
//     the MUTATED content and fail an unrelated, unmutated assertion —
//     reproduced live: standalone `node scripts/verifyVideoTimeoutReconcile.js`
//     was 5/5 green, but it failed intermittently inside the --concurrency=16
//     pool with "source text not found" errors on lines that are never
//     actually missing.
//     Quarantining these three here was NOT a sufficient fix on its own: this
//     runner's own timeout path (below) sends SIGTERM then, after a grace
//     period, SIGKILL; no verify* script installs a SIGTERM handler, and
//     reproduced directly on Node 22/26 — with no handler, SIGTERM/SIGKILL
//     terminate the process WITHOUT running a pending `finally` block. So a
//     timeout, a CI abort, or a Ctrl-C mid-mutation (even serialized, even
//     run standalone outside this runner entirely) could still leave the
//     real file sitting mutated on disk; `UNSAFE_FOR_PARALLEL` only ever
//     serialized these three within one runVerifySuite.js invocation, never
//     protected a direct `node scripts/verifyFoo.js` or a CI job. The actual
//     fix: all three now mutate a private path under os.tmpdir()
//     (`${name}-${basename}-${pid}-${Date.now()}`, matching the pattern
//     verifyRatingPairAtomic.js/verifySeedClass.js already used) and never
//     write to the real file at all — proven by running each mutator and
//     SIGTERM'ing it mid-mutation: before the fix the real file was left
//     dirty (`git status` showed a modified services/atlasVideoService.js);
//     after, the real file stayed clean under the identical kill, with only
//     an orphaned file under the OS tmp dir (harmless, outside the repo).
// (2) REAL-TIMER RACE (the same shape as the verifyDirectorFallbackChain.js
//     C4 flake, fixed below in this same change) — verifyCampaignRunHeartbeat.js
//     (a real `setInterval(10ms)` ticker asserted to fire `>=5` times across a
//     real `sleep(120)`) and verifyConcurrencyConfig.js (two real ~80ms
//     `setTimeout` sleeps asserted to overlap within a 140ms wall-clock
//     window) both have single-digit-millisecond margins that a real OS
//     scheduler cannot guarantee under CPU oversubscription. Making these
//     deterministic the way C4 was would mean auditing and stubbing timing
//     internals of `campaignRunHeartbeatService`/`atlasVideoService` this
//     change did not otherwise need to touch — out of scope here, so they
//     stay quarantined instead of individually fixed. This is an unrelated
//     root cause from (1) above (a real-timer margin, not a shared-file
//     write) and fixing (1) does nothing for it — do not unquarantine these
//     two without separately making their timers deterministic.
//
// Both remaining entries are genuine, reproducible parallel-UNsafety, not
// module-load contention guesswork — see docs/PARALLEL_WORK.md for the full
// stress-test evidence. Listing them here is the honest fix: they run alone,
// serially, after the parallel pool drains, so their own tight real-timer
// margins never have to compete with 15 other processes for the CPU.
const UNSAFE_FOR_PARALLEL = new Set([
  'verifyCampaignRunHeartbeat.js',
  'verifyConcurrencyConfig.js',
]);

// macOS has no `timeout(1)` binary, so this is a JS timer + child.kill(),
// never a shelled-out `timeout` wrapper.
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CONCURRENCY = Math.max(1, Math.min(8, os.cpus().length));

function parseArgs(argv) {
  const opts = { affected: false, affectedBase: null, concurrency: null, timeoutMs: null, list: false, only: [] };
  for (const arg of argv) {
    if (arg === '--affected') opts.affected = true;
    else if (arg.startsWith('--affected=')) { opts.affected = true; opts.affectedBase = arg.slice('--affected='.length); }
    else if (arg.startsWith('--concurrency=')) opts.concurrency = parseInt(arg.slice('--concurrency='.length), 10);
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = parseInt(arg.slice('--timeout='.length), 10);
    else if (arg === '--list') opts.list = true;
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0); }
    else if (arg.startsWith('--')) { console.error(`runVerifySuite: unknown flag ${arg}`); process.exit(1); }
    else opts.only.push(path.basename(arg));
  }
  return opts;
}

function printHelp() {
  const header = fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 40).join('\n');
  console.log(header);
}

function discoverScripts() {
  return fs.readdirSync(SCRIPTS_DIR).filter(f => VERIFY_RE.test(f)).sort();
}

function git(args, opts) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

// ---------------------------------------------------------------------------
// Static require/readFileSync/import graph resolution (FIX 1/2, 2026-08-19).
//
// Replaces the old "does a changed file's path fragment appear as a raw
// text substring in a script" heuristic with actual resolution of each
// script's real dependency graph, walked the same way Node itself would
// resolve a relative require. This is intentionally NOT a full JS parser —
// it recognizes the small, consistent set of patterns this codebase's
// verify* scripts actually use: plain string-literal requires/imports,
// `path.join(__dirname, ...)`/`path.resolve(__dirname, ...)` calls (used
// directly or via a top-level `const ROOT = path.join(__dirname, '..')`-
// style alias, which ~53 of the 174 scripts define), read as the target of
// require()/require.resolve()/readFileSync()/readFile()/import. Anything
// more dynamic than that (e.g. `require(someVariable)`) is simply skipped —
// best-effort, not required to be complete; see the CORE_DIRS fail-loud
// check below for what backstops the gap.
// ---------------------------------------------------------------------------

const _statKindCache = new Map();
function statKind(p) {
  if (_statKindCache.has(p)) return _statKindCache.get(p);
  let kind = null;
  try {
    const st = fs.statSync(p);
    if (st.isFile()) kind = 'file';
    else if (st.isDirectory()) kind = 'dir';
  } catch (e) { /* doesn't exist */ }
  _statKindCache.set(p, kind);
  return kind;
}

// Resolves a (possibly extension-less, possibly directory) absolute path the
// same way Node's own relative-require resolution would, so a bare
// `require('../config')` pointing at config/index.js and a fully-spelled
// `require('../models/Ad.js')` both land on the one real absolute file path
// — matching is meaningless otherwise. Applied identically to both the
// "changed file" side and the "resolved require target" side.
function canonicalizeProjectPath(absNoExt) {
  for (const suffix of ['', '.js', '.mjs', '.json']) {
    const candidate = absNoExt + suffix;
    if (statKind(candidate) === 'file') return path.normalize(candidate);
  }
  if (statKind(absNoExt) === 'dir') {
    for (const idx of ['index.js', 'index.mjs', 'index.json']) {
      const candidate = path.join(absNoExt, idx);
      if (statKind(candidate) === 'file') return path.normalize(candidate);
    }
  }
  // Not found on disk (deleted file, or a resolution guess that didn't
  // land) — return the best-effort normalized path anyway so a
  // same-shaped miss on the "changed file" side still compares equal.
  return path.normalize(absNoExt);
}

// Scans `source` starting at the index of a call's opening '(' and returns
// { argsText, afterIdx } for its balanced-paren argument list, respecting
// nested parens/brackets and string/template literals (so a comma inside a
// nested call or a string doesn't get mistaken for an argument separator).
// Returns null if the parens never balance.
function scanBalancedArgs(source, openIdx) {
  let depth = 0;
  let inString = null;
  let argsStart = -1;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '(') { depth++; if (depth === 1) argsStart = i + 1; continue; }
    if (ch === ')') {
      depth--;
      if (depth === 0) return { argsText: source.slice(argsStart, i), afterIdx: i + 1 };
    }
  }
  return null;
}

// Splits a raw argument-list source string on top-level commas (depth 0,
// outside strings/brackets), returning trimmed argument source strings.
function splitTopLevelArgs(argsText) {
  const parts = [];
  let depth = 0;
  let inString = null;
  let start = 0;
  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) { parts.push(argsText.slice(start, i).trim()); start = i + 1; }
  }
  const last = argsText.slice(start).trim();
  if (last.length) parts.push(last);
  return parts.filter(Boolean);
}

const STRING_LITERAL_RE = /^(['"`])([\s\S]*)\1$/;

// Best-effort static evaluation of a single JS expression source string down
// to a path string, given what `__dirname` resolves to in that file
// (`fromDir`) and a symbol table of other top-level `const IDENT = <expr>`
// aliases already resolved for this file. Returns null for anything more
// dynamic than a string literal, `__dirname`, a known alias, or a
// path.join/path.resolve call over more such atoms — i.e. a genuinely
// dynamic require this can't resolve, safe to simply skip.
function evalPathExpr(exprSrc, fromDir, symbols) {
  const src = exprSrc.trim();
  if (!src) return null;

  const lit = STRING_LITERAL_RE.exec(src);
  if (lit) return /\$\{/.test(lit[2]) ? null : lit[2];

  if (src === '__dirname') return fromDir;
  if (symbols.has(src)) return symbols.get(src);

  const callMatch = /^path\.(join|resolve)\(([\s\S]*)\)$/.exec(src);
  if (callMatch) {
    const evaluated = [];
    for (const part of splitTopLevelArgs(callMatch[2])) {
      const v = evalPathExpr(part, fromDir, symbols);
      if (v === null) return null; // one unresolvable arg poisons the whole call
      evaluated.push(v);
    }
    if (!evaluated.length) return null;
    return callMatch[1] === 'resolve' ? path.resolve(...evaluated) : path.join(...evaluated);
  }

  return null;
}

// Finds top-level `const IDENT = <expr>;`-shaped aliases whose initializer
// is itself statically resolvable (overwhelmingly `path.join(__dirname,
// '..')`-shaped ROOT aliases in this codebase, but written generically).
// Built in source order so a later alias may reference an earlier one.
function extractSymbolTable(source, fromDir) {
  const symbols = new Map();
  const assignRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m;
  while ((m = assignRe.exec(source))) {
    const ident = m[1];
    const afterEq = assignRe.lastIndex;
    const rest = source.slice(afterEq);
    const callHead = /^path\.(?:join|resolve)\(/.exec(rest);
    if (callHead) {
      const scanned = scanBalancedArgs(source, afterEq + callHead[0].length - 1);
      if (scanned) {
        const value = evalPathExpr(rest.slice(0, scanned.afterIdx - afterEq), fromDir, symbols);
        if (value !== null) symbols.set(ident, value);
      }
    } else if (/^__dirname\s*[;,)]/.test(rest)) {
      symbols.set(ident, fromDir);
    }
  }
  return symbols;
}

// Finds every require()/require.resolve()/readFileSync()/readFile()/import
// call or static `import ... from` site in `source` and returns each one's
// raw (unevaluated) first/only relevant argument, tagged by edge kind:
//   'code' — require/require.resolve/import (static or dynamic): this file's
//            module graph really loads and executes the target, so a
//            dependent's transitive closure must keep expanding through it.
//   'text' — readFileSync/readFile: this file inspects the target's raw
//            source TEXT (the "source-pin" pattern used throughout this
//            repo's verify* scripts, e.g. asserting a regex against another
//            file's contents) without requiring/executing it. The assertion
//            is invariant to what the *target* itself requires — reading
//            index.js's text to check for one line does not depend on
//            whatever module index.js's OTHER lines happen to require — so
//            this must be a LEAF edge, never expanded further. Conflating
//            the two (an earlier version of this function did) reintroduces
//            the exact false-positive class FIX 1/2 exists to remove: e.g.
//            verifyAgentRegistry.js reads index.js's text for one assertion;
//            index.js separately requires all ~20 route files including
//            routes/me.js, and recursing into that make every one of those
//            routes look like a "dependent" of verifyAgentRegistry.js, which
//            is exactly the kind of coincidental match this file exists to
//            eliminate.
function findDirectRefTargets(source) {
  const targets = []; // { raw, kind }
  const callNameRe = /\b(require\.resolve|require|readFileSync|readFile|import)\s*\(/g;
  let m;
  while ((m = callNameRe.exec(source))) {
    const openIdx = callNameRe.lastIndex - 1;
    const scanned = scanBalancedArgs(source, openIdx);
    if (!scanned) continue;
    callNameRe.lastIndex = scanned.afterIdx;
    const parts = splitTopLevelArgs(scanned.argsText);
    if (!parts.length) continue;
    const kind = (m[1] === 'readFileSync' || m[1] === 'readFile') ? 'text' : 'code';
    targets.push({ raw: parts[0], kind });
  }
  const staticImportRe = /\bimport\s+(?:[^'"();]+\bfrom\s+)?(['"])((?:\\.|(?!\1).)*)\1/g;
  while ((m = staticImportRe.exec(source))) targets.push({ raw: `${m[1]}${m[2]}${m[1]}`, kind: 'code' });
  return targets;
}

const _directRefsCache = new Map();
// Direct (non-transitive) refs of `absFilePath`, split by edge kind:
//   codeRefs — require/require.resolve/import targets (recursable).
//   textRefs — readFileSync/readFile targets (leaves only — see
//              findDirectRefTargets for why these must not be expanded).
// Bare package specifiers ('fs', 'mongoose', ...) and anything resolving
// outside the repo or into node_modules are not project-local and excluded.
// If the SAME path is reached via both kinds in one file, it counts as
// 'code' (an actual require already justifies full recursion regardless of
// an additional text-pin elsewhere in the same file).
function getDirectRefs(absFilePath) {
  if (_directRefsCache.has(absFilePath)) return _directRefsCache.get(absFilePath);
  const kindByPath = new Map();
  try {
    const source = fs.readFileSync(absFilePath, 'utf8');
    const fromDir = path.dirname(absFilePath);
    const symbols = extractSymbolTable(source, fromDir);
    for (const { raw, kind } of findDirectRefTargets(source)) {
      const val = evalPathExpr(raw, fromDir, symbols);
      if (val === null) continue;
      if (!val.startsWith('.') && !path.isAbsolute(val)) continue; // bare package name
      const abs = path.isAbsolute(val) ? val : path.resolve(fromDir, val);
      if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) continue; // outside the repo
      if (abs.includes(`${path.sep}node_modules${path.sep}`)) continue;
      const canonical = canonicalizeProjectPath(abs);
      if (kind === 'code' || !kindByPath.has(canonical)) kindByPath.set(canonical, kind);
    }
  } catch (e) { /* unreadable — treat as no refs */ }
  const result = {
    codeRefs: new Set([...kindByPath].filter(([, k]) => k === 'code').map(([p]) => p)),
    textRefs: new Set([...kindByPath].filter(([, k]) => k === 'text').map(([p]) => p)),
  };
  _directRefsCache.set(absFilePath, result);
  return result;
}

const _closureCache = new Map();
// Transitive closure reachable from `absFilePath`: its own direct refs (both
// kinds — either kind changing could genuinely affect this file), plus,
// recursively, everything reachable by further following 'code' edges only
// (never 'text' edges — see findDirectRefTargets). Also never recurses past
// a non-.js/.mjs file (e.g. a JSON fixture has no further refs to expand).
// Cycle-safe: a node already on the current call stack returns empty rather
// than recursing forever, and is not cached mid-cycle — only the outer,
// fully-unwound call caches its result.
function getClosure(absFilePath, stack) {
  stack = stack || new Set();
  if (_closureCache.has(absFilePath)) return _closureCache.get(absFilePath);
  if (stack.has(absFilePath)) return new Set();
  stack.add(absFilePath);
  const { codeRefs, textRefs } = getDirectRefs(absFilePath);
  const result = new Set([...codeRefs, ...textRefs]);
  for (const dep of codeRefs) {
    if (!/\.(js|mjs)$/.test(dep)) continue;
    for (const s of getClosure(dep, stack)) result.add(s);
  }
  stack.delete(absFilePath);
  _closureCache.set(absFilePath, result);
  return result;
}

const RUNNER_SELF_REL = path.relative(ROOT, __filename).split(path.sep).join('/');

/**
 * Returns the sorted list of affected verify scripts, or null to mean
 * "could not confidently resolve this — caller should fall back to running
 * everything" (because the diff itself couldn't be computed, because this
 * runner's own file changed, or because a changed file under a CORE_DIRS
 * directory matched no real dependent and that's treated as a resolution
 * gap rather than a genuine "unaffected" verdict).
 */
function computeAffected(base) {
  const ref = base || 'origin/main';
  let changed = [];
  try {
    changed = git(['diff', '--name-only', `${ref}...HEAD`]).split('\n');
  } catch (e) {
    try {
      changed = git(['diff', '--name-only', ref]).split('\n');
    } catch (e2) {
      console.error(`runVerifySuite: could not diff against "${ref}" (${e2.message.trim()}).`);
      return null;
    }
  }
  // Fold in uncommitted changes too — staged, unstaged, AND untracked.
  // `git diff` never lists untracked ('??') files, so a brand-new file (e.g.
  // a freshly-written verify script) was previously invisible to --affected
  // entirely, reporting "nothing to run" instead of trivially selecting it.
  try {
    changed = changed.concat(git(['diff', '--name-only', 'HEAD']).split('\n'));
    changed = changed.concat(git(['diff', '--name-only', '--cached']).split('\n'));
    changed = changed.concat(git(['ls-files', '--others', '--exclude-standard']).split('\n'));
  } catch (e) { /* best-effort; not fatal */ }

  changed = [...new Set(changed.map(s => s.trim()).filter(Boolean))];
  if (changed.length === 0) return [];

  // This runner's own selection logic changing is a special case CORE_DIRS
  // deliberately doesn't cover (nothing requires this file, so no
  // dependency-graph signal can ever flag it) — yet a bug here can
  // invalidate every verdict --affected produces for every OTHER change too.
  // Never trust --affected to reason about itself: always fall back.
  if (changed.includes(RUNNER_SELF_REL)) {
    console.error(
      `runVerifySuite: scripts/runVerifySuite.js itself changed — --affected's own ` +
      `selection logic is exactly what's in question, so it can't reason about itself. ` +
      `Falling back to the FULL suite.`
    );
    return null;
  }

  const allScripts = discoverScripts();
  const selected = new Set();

  // 1. A changed verify script is trivially affected.
  const remaining = [];
  for (const rel of changed) {
    const base2 = path.basename(rel);
    if (VERIFY_RE.test(base2) && allScripts.includes(base2)) selected.add(base2);
    else remaining.push(rel);
  }

  // 2. Any other changed file: a verify script is affected if it genuinely,
  //    statically references the changed file — checked by resolving each
  //    script's real dependency graph (transitive) and testing whether the
  //    changed file's own canonicalized absolute path appears in it. See the
  //    top-of-file doc comment and the resolver functions above for why this
  //    replaced the old raw-text substring check.
  if (remaining.length) {
    const changedAbsByRel = new Map();
    for (const rel of remaining) {
      changedAbsByRel.set(rel, canonicalizeProjectPath(path.resolve(ROOT, rel)));
    }

    const matchedAny = new Set(); // changed-file rel paths that hit >=1 script
    for (const script of allScripts) {
      const closure = getClosure(path.join(SCRIPTS_DIR, script));
      for (const [rel, abs] of changedAbsByRel) {
        if (closure.has(abs)) {
          selected.add(script);
          matchedAny.add(rel);
        }
      }
    }

    // 3. Fail loud, not silent: a changed file under a directory everything
    //    else routinely depends on (CORE_DIRS) that still matched no real
    //    dependent is a signal the graph couldn't confidently resolve it —
    //    not proof it has zero dependents (e.g. models/Job.js today: a real,
    //    actively required model with no verify* script exercising it
    //    directly, confirmed by hand — routes/jobs.js, routes/upload.js and
    //    routes/detect.js are its only requirers and no verify* script
    //    reaches any of those three either). Because matches are now real
    //    resolved paths rather than text coincidences, a wrong match can no
    //    longer mask a real zero the way it used to (FIX 2's bug) — an empty
    //    result here is a genuine "nothing currently exercises this."
    const unresolvedCore = remaining.filter(
      (rel) => CORE_DIRS.has(rel.split('/')[0]) && !matchedAny.has(rel)
    );
    if (unresolvedCore.length) {
      console.error(
        `runVerifySuite: --affected could not confidently resolve dependents for ` +
        `${unresolvedCore.join(', ')} (changed core-dir file(s) matched no verify ` +
        `script's real require/readFileSync graph). Falling back to the FULL suite ` +
        `rather than risk a false "nothing to run".`
      );
      return null;
    }
  }

  return [...selected].sort();
}

// Grace period between SIGTERM and a forced SIGKILL when a timed-out script
// doesn't exit on its own. No verify* script installs a SIGTERM handler
// today, but scripts/retitleDriver.js in this same repo already does
// (`process.on('SIGTERM', ...)` that finishes current work before exiting) —
// a future verify* script sharing that pattern, or simply looping instead of
// finishing, would otherwise survive SIGTERM and hang the whole runner
// indefinitely: no output, no exit code, ever.
const KILL_GRACE_MS = 5000;

function runOne(script, timeoutMs) {
  return new Promise((resolve) => {
    const file = path.join(SCRIPTS_DIR, script);
    const start = Date.now();
    const child = spawn(process.execPath, [file], { cwd: ROOT, env: process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) { /* already exited */ }
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ script, code: timedOut ? 1 : code, timedOut, ms: Date.now() - start, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ script, code: 1, timedOut: false, ms: Date.now() - start, stdout, stderr: String((err && err.stack) || err) });
    });
  });
}

async function runPool(scripts, concurrency, timeoutMs) {
  const results = new Array(scripts.length);
  let idx = 0;
  async function worker() {
    for (;;) {
      const my = idx++;
      if (my >= scripts.length) return;
      results[my] = await runOne(scripts[my], timeoutMs);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, scripts.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;

  const allScripts = discoverScripts();
  let scripts;
  if (opts.only.length) {
    scripts = [...new Set(opts.only)];
  } else if (opts.affected) {
    const affected = computeAffected(opts.affectedBase);
    if (affected === null) {
      console.log('runVerifySuite: --affected could not confidently resolve the affected set; falling back to the FULL suite.\n');
      scripts = allScripts;
    } else {
      scripts = affected;
    }
  } else {
    scripts = allScripts;
  }

  const allSet = new Set(allScripts);
  const unknown = scripts.filter(s => !allSet.has(s));
  if (unknown.length) {
    console.error(`runVerifySuite: unknown script(s), not found in scripts/: ${unknown.join(', ')}`);
    process.exit(1);
  }

  if (opts.list) {
    console.log(scripts.length ? scripts.join('\n') : '(nothing selected)');
    return;
  }

  if (scripts.length === 0) {
    console.log('runVerifySuite: no verify scripts affected by the current changes. Nothing to run.');
    return;
  }

  const parallelScripts = scripts.filter(s => !UNSAFE_FOR_PARALLEL.has(s));
  const serialScripts = scripts.filter(s => UNSAFE_FOR_PARALLEL.has(s));

  console.log(
    `runVerifySuite: ${scripts.length} script(s) selected` +
    (opts.affected ? ' (--affected)' : '') +
    ` — ${parallelScripts.length} in a pool of ${concurrency}` +
    (serialScripts.length ? `, ${serialScripts.length} serially (UNSAFE_FOR_PARALLEL)` : '') +
    `, ${timeoutMs}ms/script timeout.\n`
  );

  const t0 = Date.now();
  const parallelResults = await runPool(parallelScripts, concurrency, timeoutMs);
  const serialResults = [];
  for (const s of serialScripts) serialResults.push(await runOne(s, timeoutMs));
  const results = [...parallelResults, ...serialResults];
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  for (const r of results) {
    const mark = r.code === 0 ? '✅' : '❌';
    console.log(`${mark} ${r.script}  (${r.ms}ms)${r.timedOut ? '  [TIMED OUT]' : ''}`);
  }

  const expected = loadExpectedFailures();

  const allFailed = results.filter(r => r.code !== 0);
  const failed = allFailed.filter(r => !expected[r.script]);          // real
  const expectedFailed = allFailed.filter(r => expected[r.script]);   // known, tolerated
  // A listed script that PASSED. This is what stops the allowlist rotting into a
  // rug: you cannot fix a harness and leave it suppressed, and you cannot park a
  // flaky script here and forget it. Removing the entry is part of the fix.
  const stale = results.filter(r => r.code === 0 && expected[r.script]);
  const passed = results.length - allFailed.length;

  if (failed.length) {
    console.log(`\n--- FAILURE DETAIL (${failed.length} of ${results.length}) ---`);
    for (const r of failed) {
      console.log(`\n===== ${r.script} (exit ${r.code}${r.timedOut ? ', timed out' : ''}) =====`);
      if (r.stdout.trim()) console.log(r.stdout.trim());
      if (r.stderr.trim()) console.error(r.stderr.trim());
    }
  }

  if (expectedFailed.length) {
    console.log(`\n--- EXPECTED FAILURES (${expectedFailed.length}), from scripts/expected-failures.json ---`);
    for (const r of expectedFailed) {
      console.log(`  ~ ${r.script} — ${expected[r.script].reason}`);
      console.log(`      remove when: ${expected[r.script].removeWhen}`);
    }
  }

  console.log(`\nrunVerifySuite: ${passed}/${results.length} passed in ${elapsedSec}s wall clock (concurrency=${concurrency}).`);
  if (expectedFailed.length) {
    console.log(`EXPECTED-FAIL (not failing the run): ${expectedFailed.map(r => r.script).join(', ')}`);
  }

  if (stale.length) {
    console.log(`\n❌ STALE EXPECTED-FAILURE ENTR${stale.length === 1 ? 'Y' : 'IES'}: ` +
      `${stale.map(r => r.script).join(', ')}`);
    console.log('   These are listed in scripts/expected-failures.json but PASSED. Whatever they');
    console.log('   were waiting on is fixed — delete the entry. An allowlist that outlives its');
    console.log('   reason silently suppresses a live harness.');
    process.exitCode = 1;
  }

  if (failed.length) {
    console.log(`FAILED: ${failed.map(r => r.script).join(', ')}`);
    process.exitCode = 1;
  }
}

// Scripts known to fail on main. See scripts/expected-failures.json for the
// contract — in particular that a listed script which PASSES fails the run.
// A malformed or missing file is a hard error, never a silent empty allowlist:
// "everything is expected to fail" and "nothing is" must not be reachable by typo.
// Ported from liquidretail_adgen's runVerifySuite.js (same mechanism, same
// contract) when CI was added here — see that repo's copy for context.
function loadExpectedFailures() {
  const p = path.join(SCRIPTS_DIR, 'expected-failures.json');
  if (!fs.existsSync(p)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`runVerifySuite: scripts/expected-failures.json is not valid JSON — ${err.message}`);
    process.exit(1);
  }
  const map = parsed && parsed.expectedFailures;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    console.error('runVerifySuite: scripts/expected-failures.json must contain an "expectedFailures" object');
    process.exit(1);
  }
  for (const [script, meta] of Object.entries(map)) {
    if (!meta || !meta.reason || !meta.removeWhen) {
      console.error(`runVerifySuite: expected-failures entry "${script}" needs both "reason" and "removeWhen"`);
      process.exit(1);
    }
  }
  return map;
}

main().catch((err) => {
  console.error('runVerifySuite: internal error:', err);
  process.exit(1);
});
