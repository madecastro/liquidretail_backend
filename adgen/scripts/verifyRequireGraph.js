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

const path = require('path');
const { resolveBackendRoot } = require('./lib/siblingBackend');
const {
  fileExists,
  dirExists,
  resolveRelativeTarget,
  buildProjectRequireGraph,
} = require('./lib/requireGraph');

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

// Scanner lives in scripts/lib/requireGraph.js (shared with
// verifyVendorDrift.js). This file keeps the vendoring-gap note and the
// pass/fail policy.

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
  const graph = buildProjectRequireGraph(SRC_DIR);
  const files = graph.files;
  const referenced = graph.referenced;
  const requireEdges = graph.requireEdges;
  const unresolvedDynamicCount = graph.unresolvedDynamicCount;
  const unresolvedDynamicSamples = graph.unresolvedDynamicSamples.map((s) => {
    // lib stores absolute paths; print repo-relative like before.
    const colon = s.indexOf(':');
    if (colon < 0) return s;
    return `${relSrc(s.slice(0, colon))}${s.slice(colon)}`;
  });

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
