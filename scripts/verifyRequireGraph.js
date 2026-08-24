#!/usr/bin/env node
'use strict';
//
// verifyRequireGraph — statically resolves every require('./...') /
// require('../...') under src/ and asserts the target actually exists on
// disk. THIS IS THE CHECK THAT WOULD HAVE CAUGHT THE PRODUCTION CRASH THIS
// REPO ALREADY SHIPPED: src/services/quoteRotationService.js requires
// './reviewAdapters/helpers'; an over-deleted directory removed that file;
// `Cannot find module './reviewAdapters/helpers'` was thrown at RUNTIME (a
// require() throws lazily, the first time that line actually executes —
// not at parse time) 9 times in production logs. `node --check` only
// parses syntax; it does not resolve a single require(). Nothing in this
// repo checked that every require target still existed on disk until now.
//
// THREE THINGS THIS HARNESS DOES, IN PRIORITY ORDER:
//
//  1. FAIL — a require('./x') / require('../x') target that does not
//     resolve to a real file (exact path, or +.js/.mjs/.json, or a
//     directory's index.js/.mjs/.json). If the identical path (adgen's
//     leading `src/` stripped) exists in the sibling liquidretail_backend
//     checkout, the failure message says so explicitly — that shape is
//     almost certainly a vendoring gap (a file this fork never copied
//     over), not a typo, and the two should not be debugged the same way.
//
//  2. INFO — a file under src/services/** with no require() edge AND no
//     path.join(__dirname, '...')-style text reference from anywhere else
//     under src/. Vendored-but-dead code. Confirmed present at the time
//     this harness was written (grepped, not guessed): campaignRunGuards.js
//     and campaignRunHeartbeat.js are mentioned only in comments elsewhere
//     in this tree, never required by anything.
//
//  3. INFO — a require() call whose argument this scan could not statically
//     resolve at all (count only, not failed — a regex over source text
//     cannot evaluate an arbitrary runtime expression, and guessing wrong
//     would be worse than reporting "unresolved"). Two shapes that LOOK
//     dynamic are resolved anyway, because this codebase actually uses
//     them: a bare identifier that is itself a top-level
//     `const IDENT = ['./a', './b', ...]` array of string literals, OR a
//     `for (const X of ARR) { require(X); }` loop variable bound to one
//     (the exact pattern src/services/reviewAdapters/index.js uses to
//     require() each of its 9 adapter modules — resolving only the first
//     shape and not the loop-variable indirection was this harness's own
//     first bug: all 9 adapter files false-flagged as dead until the
//     for-of-source map was added), and
//     `path.join(__dirname, 'lit', 'lit.js')` built entirely from string
//     literals (used by src/services/systemConfigService.js to name the
//     four canonical brandScripts/*.script.js files it then
//     fs.readFileSync's as text — folded into the "referenced" set for
//     check 2 so those four files are not misreported as dead).
//
// NOT AN AST PARSER — same convention as liquidretail_backend's
// scripts/runVerifySuite.js (ported alongside this file; the balanced-paren
// / balanced-bracket / quote-aware scanning below is adapted from it, with
// attribution kept in each function's comment). Good enough for the require
// shapes this codebase actually uses; anything genuinely dynamic
// (`require(someComputedVar)` with no static array behind it) is counted
// and skipped, never guessed at.
//
// Fully offline: reads only files already on disk under src/, plus,
// read-only, the sibling backend's tree for the vendoring-gap note and the
// vendoring-gap INFO summary below (scripts/lib/siblingBackend.js — absent
// sibling is a skip, not a failure). No DB, no network, no API key, and no
// npm dependency at all — pure fs + regex, so unlike verifyModelParity.js
// this one needs no node_modules and runs in a completely bare checkout.
//
// REVERT-PROOF (see session report for this exact run):
//   node scripts/verifyRequireGraph.js                              → pass
//   mv src/services/reviewAdapters/helpers.js /tmp/helpers.js.bak   → break it
//   node scripts/verifyRequireGraph.js                              → FAILS,
//     naming the exact requiring file, line, and unresolved target
//   mv /tmp/helpers.js.bak src/services/reviewAdapters/helpers.js   → restore
//   node scripts/verifyRequireGraph.js                              → pass again

const fs = require('fs');
const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');
const SERVICES_DIR = path.join(SRC_DIR, 'services');
const BACKEND_ROOT = resolveBackendRoot(ROOT);

let pass = 0;
const failures = [];
const infos = [];

function check(label, fn) {
  try {
    fn();
    pass += 1;
  } catch (err) {
    failures.push(`${label}: ${err.message.split('\n')[0].slice(0, 400)}`);
  }
}

function info(label) {
  infos.push(label);
}

function relSrc(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// Filesystem walk. Deliberately does not pull in liquidretail_backend's
// scripts/lib/sourceWalk.js (a different repo — do not reach across the
// require graph this file itself checks). Same skip philosophy, smaller
// scope: this repo has no worktrees or drafts nested inside src/ today, but
// the dotdir/underscore-name defense costs nothing and matches the sibling
// repo's own hard lesson (CLAUDE.md: a one-character skip-list miss let a
// nested worktree's uncommitted files corrupt a money harness's verdict).
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'build']);

function shouldSkipDir(name) {
  if (name === '.' || name === '..') return true;
  if (SKIP_DIRS.has(name)) return true;
  if (name.startsWith('.')) return true;
  return false;
}

function listSourceFiles(rootDir) {
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out.sort();
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Balanced-paren / balanced-bracket / quote-aware scanning, adapted from
// liquidretail_backend/scripts/runVerifySuite.js (scanBalancedArgs /
// splitTopLevelArgs there). Kept minimal — this file does not need that
// runner's path.join(__dirname,...) alias symbol table, only a plain
// balanced-arg scan for require(...)/path.join(...)/path.resolve(...) calls
// and a balanced-bracket scan for `const X = [...]` array literals.
// ---------------------------------------------------------------------------

function scanBalancedParens(source, openIdx) {
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
      if (depth === 0) return { bodyText: source.slice(argsStart, i), afterIdx: i + 1 };
    }
  }
  return null;
}

function scanBalancedBrackets(source, openIdx) {
  let depth = 0;
  let inString = null;
  let bodyStart = -1;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') { inString = ch; continue; }
    if (ch === '[') { depth++; if (depth === 1) bodyStart = i + 1; continue; }
    if (ch === ']') {
      depth--;
      if (depth === 0) return { bodyText: source.slice(bodyStart, i), afterIdx: i + 1 };
    }
  }
  return null;
}

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

function asStaticStringLiteral(exprSrc) {
  const src = exprSrc.trim();
  const lit = STRING_LITERAL_RE.exec(src);
  if (!lit) return null;
  if (/\$\{/.test(lit[2])) return null; // template literal with an interpolation — genuinely dynamic
  return lit[2];
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// Per-file extraction.
// ---------------------------------------------------------------------------

// Top-level `const IDENT = ['./a', './b', ...]` where every element is a
// plain string literal. Powers the reviewAdapters/index.js
// `for (const mod of ADAPTER_MODULES) { require(mod); }` pattern below.
function extractStringArrayConstants(source) {
  const table = new Map();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\[/g;
  let m;
  while ((m = re.exec(source))) {
    const openIdx = re.lastIndex - 1; // index of the '['
    const scanned = scanBalancedBrackets(source, openIdx);
    if (!scanned) continue;
    const parts = splitTopLevelArgs(scanned.bodyText);
    const literals = [];
    let allLiteral = parts.length > 0;
    for (const part of parts) {
      const lit = asStaticStringLiteral(part);
      if (lit === null) { allLiteral = false; break; }
      literals.push(lit);
    }
    if (allLiteral) table.set(m[1], literals);
  }
  return table;
}

// `for (const IDENT of SOME_ARRAY) { ... require(IDENT) ... }` — the exact
// shape src/services/reviewAdapters/index.js uses (loop variable `mod` over
// `ADAPTER_MODULES`). A require() of the LOOP VARIABLE is not itself a
// `const IDENT = [...]` (that lives on the iterable, one level up), so this
// is a separate map: loop variable name -> iterable identifier name. Only
// covers `for (const X of Y)` where Y is a bare identifier — this codebase
// has exactly one dynamic-require loop and that is its exact shape.
function extractForOfLoopVarSources(source) {
  const table = new Map();
  const re = /\bfor\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+([A-Za-z_$][\w$]*)\s*\)/g;
  let m;
  while ((m = re.exec(source))) table.set(m[1], m[2]);
  return table;
}

// Every require(<expr>) call site. Returns the raw (unevaluated) first
// argument's source text plus its line number. `require.resolve(...)` is
// deliberately NOT matched (a literal '.' follows `require`, not '(').
function findRequireCalls(source) {
  const calls = [];
  const re = /\brequire\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const openIdx = re.lastIndex - 1;
    const scanned = scanBalancedParens(source, openIdx);
    if (!scanned) continue;
    re.lastIndex = scanned.afterIdx;
    const parts = splitTopLevelArgs(scanned.bodyText);
    if (!parts.length) continue;
    calls.push({ raw: parts[0], line: lineOf(source, m.index) });
  }
  return calls;
}

// Every path.join(__dirname, 'lit', ...) / path.resolve(__dirname, 'lit', ...)
// call built entirely from __dirname + string literals. Used only to grow
// the "referenced" set for the dead-code check (2) — a file named this way
// is being depended on for its TEXT (fs.readFileSync elsewhere), not
// require()'d, so it is never added to the FAIL-checked require graph.
function findDirnameJoinTargets(source) {
  const targets = [];
  const re = /\bpath\.(join|resolve)\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const openIdx = re.lastIndex - 1;
    const scanned = scanBalancedParens(source, openIdx);
    if (!scanned) continue;
    re.lastIndex = scanned.afterIdx;
    const parts = splitTopLevelArgs(scanned.bodyText);
    if (!parts.length || parts[0].trim() !== '__dirname') continue;
    const rest = [];
    let allLiteral = true;
    for (let i = 1; i < parts.length; i++) {
      const lit = asStaticStringLiteral(parts[i]);
      if (lit === null) { allLiteral = false; break; }
      rest.push(lit);
    }
    if (allLiteral && rest.length) targets.push(rest);
  }
  return targets;
}

// Resolves a relative require target the same way Node's own require()
// would: exact path, then +.js/.mjs/.json, then (if a directory)
// index.js/.mjs/.json.
function resolveRelativeTarget(fromDir, rawTarget) {
  const absNoExt = path.resolve(fromDir, rawTarget);
  for (const suffix of ['', '.js', '.mjs', '.json']) {
    const candidate = absNoExt + suffix;
    if (fileExists(candidate)) return candidate;
  }
  if (dirExists(absNoExt)) {
    for (const idx of ['index.js', 'index.mjs', 'index.json']) {
      const candidate = path.join(absNoExt, idx);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

// If `rawTarget` (as required from `fromFile`) doesn't resolve in adgen,
// check whether the identical relative-to-src/ path exists in the sibling
// backend — that shape is a vendoring gap, not a typo, and worth saying so.
function vendoringGapNote(fromFile, rawTarget) {
  if (!BACKEND_ROOT) return '';
  const wouldBeAbs = path.resolve(path.dirname(fromFile), rawTarget);
  const relFromSrc = path.relative(SRC_DIR, wouldBeAbs);
  if (relFromSrc.startsWith('..')) return ''; // resolved outside src/ entirely — unexpected, no note
  for (const suffix of ['', '.js', '.mjs', '.json']) {
    const candidate = path.join(BACKEND_ROOT, relFromSrc + suffix);
    if (fileExists(candidate)) {
      return ` — EXISTS in liquidretail_backend at ${path.relative(BACKEND_ROOT, candidate)} (likely a vendoring gap — never copied into adgen — not a typo)`;
    }
  }
  if (dirExists(path.join(BACKEND_ROOT, relFromSrc))) {
    for (const idx of ['index.js', 'index.mjs', 'index.json']) {
      const candidate = path.join(BACKEND_ROOT, relFromSrc, idx);
      if (fileExists(candidate)) {
        return ` — EXISTS in liquidretail_backend at ${path.relative(BACKEND_ROOT, candidate)} (likely a vendoring gap — not a typo)`;
      }
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main() {
  const files = listSourceFiles(SRC_DIR);
  const referenced = new Set(); // absolute paths this scan found SOME reference to
  const requireEdges = []; // { fromFile, line, raw, viaConst? } — project-local only
  let unresolvedDynamicCount = 0;
  const unresolvedDynamicSamples = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const arrayConsts = extractStringArrayConstants(source);
    const forOfSources = extractForOfLoopVarSources(source);

    for (const call of findRequireCalls(source)) {
      const literal = asStaticStringLiteral(call.raw);
      if (literal !== null) {
        if (literal.startsWith('.')) requireEdges.push({ file, line: call.line, raw: literal });
        // bare npm package name or absolute path — not project-local, not our concern
        continue;
      }
      const bareIdent = call.raw.trim();
      let arrayIdent = null;
      if (/^[A-Za-z_$][\w$]*$/.test(bareIdent)) {
        if (arrayConsts.has(bareIdent)) arrayIdent = bareIdent;
        else if (forOfSources.has(bareIdent) && arrayConsts.has(forOfSources.get(bareIdent))) arrayIdent = forOfSources.get(bareIdent);
      }
      if (arrayIdent) {
        for (const target of arrayConsts.get(arrayIdent)) {
          if (target.startsWith('.')) requireEdges.push({ file, line: call.line, raw: target, viaConst: arrayIdent });
        }
        continue;
      }
      unresolvedDynamicCount += 1;
      if (unresolvedDynamicSamples.length < 8) {
        unresolvedDynamicSamples.push(`${relSrc(file)}:${call.line} require(${call.raw.slice(0, 60)})`);
      }
    }

    for (const restParts of findDirnameJoinTargets(source)) {
      const resolved = path.resolve(path.dirname(file), ...restParts);
      referenced.add(resolved);
    }
  }

  // Check 1 — every project-local require edge must resolve to a real file.
  for (const edge of requireEdges) {
    const label = `${relSrc(edge.file)}:${edge.line} require('${edge.raw}')${edge.viaConst ? ` (via ${edge.viaConst})` : ''}`;
    check(label, () => {
      const resolved = resolveRelativeTarget(path.dirname(edge.file), edge.raw);
      if (!resolved) {
        throw new Error(`target does not resolve to any file on disk${vendoringGapNote(edge.file, edge.raw)}`);
      }
      referenced.add(resolved);
    });
  }

  // Check 2 — dead vendored code under src/services/**.
  const serviceFiles = files.filter((f) => f === SERVICES_DIR || f.startsWith(SERVICES_DIR + path.sep));
  const deadServiceFiles = serviceFiles.filter((f) => !referenced.has(f)).sort();
  if (deadServiceFiles.length) {
    info(`${deadServiceFiles.length} file(s) under src/services/ have no require() or path.join(__dirname,...) reference anywhere in src/ — vendored but apparently dead:`);
    for (const f of deadServiceFiles) info(`    ${relSrc(f)}`);
  } else {
    info('every file under src/services/ is referenced from somewhere in src/ (require() or path.join(__dirname,...) text reference).');
  }

  // Check 3 — unresolvable dynamic require() arguments (count only).
  if (unresolvedDynamicCount) {
    info(`${unresolvedDynamicCount} require() call(s) had an argument this scan could not statically resolve (not failed — see samples):`);
    for (const s of unresolvedDynamicSamples) info(`    ${s}`);
    if (unresolvedDynamicCount > unresolvedDynamicSamples.length) info(`    …and ${unresolvedDynamicCount - unresolvedDynamicSamples.length} more`);
  } else {
    info('every require() call in src/ resolved to either a string literal or a statically-known array of them.');
  }

  if (!BACKEND_ROOT) {
    info('sibling liquidretail_backend not found (checked ADGEN_BACKEND_PATH and ../liquidretail_backend) — vendoring-gap notes on any FAIL below are unavailable, not wrong.');
  }

  const total = pass + failures.length;
  console.log(`verifyRequireGraph: scanned ${files.length} file(s) under src/, ${requireEdges.length} project-local require() edge(s) checked.`);
  for (const line of infos) console.log(`  info: ${line}`);

  if (failures.length) {
    console.log(`\n❌ verifyRequireGraph: ${failures.length} of ${total} require target(s) FAILED to resolve`);
    for (const f of failures) console.log(`   • ${f}`);
    process.exit(1);
  }
  console.log(`\n✅ verifyRequireGraph: ${total}/${total} require target(s) resolved`);
}

main();
