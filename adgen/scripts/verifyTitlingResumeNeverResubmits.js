#!/usr/bin/env node
'use strict';
//
// verifyTitlingResumeNeverResubmits — THE MONEY CHECK for the titling-
// recoverability fix. A resumed titling attempt must NEVER re-submit a
// paid Atlas Omni video generation. The master already exists
// (veoVideoUrl / veoPredictionId persisted) — resuming means re-running
// Remotion titling on the EXISTING master, never re-calling Omni.
//
// atlasVideoService.js's submitGeneration() is the ONLY function in this
// repo that makes that billable POST. This harness proves the resume path
// (titlingResumeService.resumeUntitledMasters → renderBrandScriptAndSave /
// qcAndStampVideoAd, and brandScriptExecutor's own stampTitlingFailureAndThrow)
// cannot reach it, two ways:
//
//   1. STRUCTURAL, on atlasVideoService.js itself: submitGeneration has
//      exactly ONE call site in the whole file, and it sits inside the
//      `else` of `if (isResuming)` — never the `if` branch (which resumes
//      an EXISTING prediction instead of submitting a new one).
//
//   2. A REAL REQUIRE-GRAPH REACHABILITY PROOF, not a textual grep: a BFS
//      over every `require('./x')`/`require('../x')` edge, starting from
//      titlingResumeService.js and brandScriptExecutor.js, resolved with
//      Node's OWN require.resolve (not a hand-rolled quote-agnostic-or-not
//      regex — this repo's own CLAUDE.md documents exactly that class of
//      bug in codemap's single-quote-blind import scanner, and a homegrown
//      resolver could make the identical mistake). If atlasVideoService.js
//      never appears in that reachable set, NO EXECUTION of the resume
//      path, under any input or branch, can ever load it — a stronger
//      claim than any single runtime trace could prove, because it covers
//      every conditional branch in the source, not just the one path a
//      mocked execution happens to exercise.
//
// A POSITIVE CONTROL (running the identical BFS from renderer.js, which
// DOES require atlasVideoService.js directly) rules out the harness being
// vacuously true from a broken parser/resolver.
//
// Revert-prove (run once by hand, not by this script — see the PR):
//   add a real `require('./atlasVideoService')` to titlingResumeService.js
//     → the reachability check goes red, count/location checks stay green
//   add a SECOND submitGeneration(...) call anywhere in atlasVideoService.js
//     → the call-site-count check goes red
//   move the real call from the else into the if(isResuming) branch
//     → the branch-location check goes red

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let pass = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failures.push(`${label}\n     ${err.message}`);
    console.log(`  ✗ ${label}`);
  }
}

// ── Structural: submitGeneration is called exactly once, only from the
// not-resuming branch ──────────────────────────────────────────────────
console.log('── A: structural — submitGeneration() has exactly one call site, gated by isResuming ──');

const ATLAS_PATH = path.join(ROOT, 'src/services/atlasVideoService.js');
const ATLAS_SRC = fs.readFileSync(ATLAS_PATH, 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const ATLAS_CODE = stripComments(ATLAS_SRC);

function lineOf(src, index) { return src.slice(0, index).split('\n').length; }

function balanced(text, openIdx, open, close) {
  if (openIdx < 0 || text[openIdx] !== open) return null;
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) { depth--; if (depth === 0) return text.slice(openIdx, i + 1); }
  }
  return null;
}

check('A1 submitGeneration is defined exactly once (async function submitGeneration()', () => {
  const defs = ATLAS_CODE.match(/\basync\s+function\s+submitGeneration\s*\(/g) || [];
  assert.strictEqual(defs.length, 1, `expected exactly 1 definition, found ${defs.length}`);
});

check('A2 submitGeneration is CALLED exactly once in the whole file (excluding its own definition and module.exports)', () => {
  const callRe = /\bsubmitGeneration\s*\(/g;
  const defRe = /\basync\s+function\s+submitGeneration\s*\(/;
  const calls = [];
  let m;
  while ((m = callRe.exec(ATLAS_CODE))) {
    const around = ATLAS_CODE.slice(Math.max(0, m.index - 20), m.index + 20);
    if (defRe.test(around)) continue;   // this occurrence IS the definition
    calls.push({ index: m.index, line: lineOf(ATLAS_CODE, m.index) });
  }
  assert.strictEqual(calls.length, 1, `expected exactly 1 call site, found ${calls.length} at line(s) ${calls.map((c) => c.line).join(', ')}`);
});

check('A3 the single call site sits inside the ELSE (not-resuming) branch of if (isResuming) — never inside the if', () => {
  const ifIdx = ATLAS_CODE.indexOf('if (isResuming) {');
  assert.ok(ifIdx > 0, 'if (isResuming) { ... } not found — has the money gate been refactored?');
  const ifOpen = ATLAS_CODE.indexOf('{', ifIdx);
  const ifBody = balanced(ATLAS_CODE, ifOpen, '{', '}');
  assert.ok(ifBody, 'if (isResuming) body is not brace-balanced — parser assumption broken');
  const afterIf = ifOpen + ifBody.length;
  const elseMatch = /^\s*else\s*\{/.exec(ATLAS_CODE.slice(afterIf, afterIf + 20));
  assert.ok(elseMatch, 'if (isResuming) { ... } must be followed immediately by an else block');
  const elseOpen = afterIf + elseMatch[0].lastIndexOf('{');
  const elseBody = balanced(ATLAS_CODE, elseOpen, '{', '}');
  assert.ok(elseBody, 'else body is not brace-balanced');

  assert.ok(!/\bsubmitGeneration\s*\(/.test(ifBody),
    'the RESUMING branch (if isResuming) must never call submitGeneration — resuming means reusing the existing predictionId');
  assert.ok(/\bsubmitGeneration\s*\(/.test(elseBody),
    'the single submitGeneration call must sit inside the else (not-resuming) branch');
});

// ── Real require-graph reachability ─────────────────────────────────────
console.log('\n── B: real require-graph reachability (Node\'s own require.resolve, not a regex re-guess) ──');

function parseRequireSpecs(src) {
  // Quote-agnostic on purpose — see this repo's own CLAUDE.md on codemap's
  // single-quote-blind import bug. This codebase is single-quoted
  // CommonJS throughout, so a double-quote-only (or single-quote-only)
  // pattern would silently under-count edges.
  const specs = [];
  const re = /require\(\s*(['"])((?:(?!\1).)+)\1\s*\)/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[2]);
  return specs;
}

function bfsRequireGraph(entryFiles) {
  const visited = new Set();
  const queue = [...entryFiles].map((f) => fs.realpathSync(f));
  const edges = [];
  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of parseRequireSpecs(src)) {
      if (!spec.startsWith('.')) continue;   // skip npm packages / core modules — only repo-relative edges matter here
      let resolved;
      try { resolved = fs.realpathSync(require.resolve(spec, { paths: [path.dirname(file)] })); }
      catch { continue; }   // optional/lazy require that only resolves under a different cwd — not a hidden edge, just unresolved here
      edges.push({ from: file, to: resolved });
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return { visited, edges };
}

const ATLAS_VIDEO_REAL = fs.realpathSync(ATLAS_PATH);

check('B1 [POSITIVE CONTROL] the BFS mechanism DOES find atlasVideoService.js when it is actually reachable (renderer.js)', () => {
  const { visited } = bfsRequireGraph([path.join(ROOT, 'src/services/renderer.js')]);
  assert.ok(visited.size > 20, `renderer.js's require graph looks too small (${visited.size} files) — resolver may be broken`);
  assert.ok(visited.has(ATLAS_VIDEO_REAL), 'renderer.js requires atlasVideoService.js directly — if the BFS misses it here, B2/B3 below would be vacuous');
});

check('B2 titlingResumeService.js\'s ENTIRE require graph never reaches atlasVideoService.js', () => {
  const { visited, edges } = bfsRequireGraph([path.join(ROOT, 'src/services/titlingResumeService.js')]);
  assert.ok(visited.size > 5, `graph looks too small (${visited.size} files) — resolver may be broken`);
  const hit = edges.find((e) => e.to === ATLAS_VIDEO_REAL);
  assert.ok(!visited.has(ATLAS_VIDEO_REAL), `atlasVideoService.js IS reachable, via ${hit ? hit.from : '(unknown edge)'}`);
});

check('B3 brandScriptExecutor.js\'s ENTIRE require graph never reaches atlasVideoService.js', () => {
  const { visited, edges } = bfsRequireGraph([path.join(ROOT, 'src/services/brandScriptExecutor.js')]);
  assert.ok(visited.size > 20, `graph looks too small (${visited.size} files) — resolver may be broken`);
  const hit = edges.find((e) => e.to === ATLAS_VIDEO_REAL);
  assert.ok(!visited.has(ATLAS_VIDEO_REAL), `atlasVideoService.js IS reachable, via ${hit ? hit.from : '(unknown edge)'}`);
});

check('B4 titlingResumeService.js does not directly name atlasVideoService/generateForAd/submitGeneration anywhere in its own source (belt on top of the graph proof)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/services/titlingResumeService.js'), 'utf8');
  assert.ok(!/atlasVideoService/.test(src));
  assert.ok(!/generateForAd/.test(src));
  assert.ok(!/submitGeneration/.test(src));
});

console.log('');
if (failures.length) {
  console.log(`❌ verifyTitlingResumeNeverResubmits: ${pass}/${pass + failures.length} checks passed\n`);
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
console.log(`✅ verifyTitlingResumeNeverResubmits: ${pass}/${pass} checks passed\n`);
