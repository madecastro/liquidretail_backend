#!/usr/bin/env node
'use strict';
//
// verifyRendererAdStatusEnum — renderer.js must only ever write Ad.status
// values that are (a) declared in models/Ad.js's own enum and (b) values
// that services/campaignRunGuards.js's classifyRunAdOutcome actually
// recognises. That second half matters more than it looks: the reaper's
// cross-service reconciliation (classifyRunAdOutcome, vendored from the
// backend — wired from renderer.js maybeFinalizeRun; see
// verifyRunFinalizesOnSettle.js) switches on Ad.status to decide
// succeeded/failed/stillRendering/requeuedAway. A renderer that ever writes
// a status value outside that switch's case labels would have its ads
// silently fall into the `default: break` branch — counted as NEITHER
// succeeded nor failed, invisible to reconciliation. A drift here would
// undercount a finalized CampaignRun.
//
// THIS HARNESS CURRENTLY PASSES — renderer.js only ever writes 'draft',
// 'failed', and 'rendering' (the requeue-for-retry case), and never
// 'queued', 'live', or 'archived'. It exists to PIN that fact so a future
// edit (e.g. a new terminal branch, or reusing 'live' to mean something
// slightly different) cannot drift without this harness turning red.
//
// Every value tested is extracted from the REAL source text of both files
// — models/Ad.js's schema declaration and campaignRunGuards.js's switch —
// never hand-copied, so this harness tracks both files' real current shape.
//
// Pure + offline: fs/path/assert only, no node_modules required.
//   node scripts/verifyRendererAdStatusEnum.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractTopLevelKeysAfter } = require('./lib/sourceLiteralScan');

const ROOT = path.join(__dirname, '..');
const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'renderer.js'), 'utf8');
const AD_MODEL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'models', 'Ad.js'), 'utf8');
const GUARDS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'campaignRunGuards.js'), 'utf8');

let checks = 0;
const failures = [];
function check(label, fn) {
  try { fn(); checks += 1; console.log(`  ✓ ${label}`); }
  catch (err) { failures.push(`${label}\n     ${err.message}`); console.log(`  ✗ ${label}`); }
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // A `//` strip must not eat a line because it contains `https://` — same
    // guard liquidretail_backend's own scanners use (verifyArchiveDigestRelease.js
    // header). Requires the slashes preceded by start-of-line or a non-`:` char.
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ═════════════════════════════════════════════════════════════════════════
// A — extract the DECLARED Ad.status enum from models/Ad.js
// ═════════════════════════════════════════════════════════════════════════
const statusNode = extractTopLevelKeysAfter(stripComments(AD_MODEL_SRC), /(?:^|\n)\s*status:\s*\{/);
assert.ok(statusNode, 'could not find Ad.status schema node — models/Ad.js shape changed, re-derive this harness');
const enumIdx = statusNode.keys.indexOf('enum');
assert.ok(enumIdx >= 0, 'Ad.status schema node has no enum member');
const enumMatch = /\[([^\]]+)\]/.exec(statusNode.members[enumIdx]);
assert.ok(enumMatch, 'could not find Ad.status enum declaration — models/Ad.js shape changed, re-derive this harness');
const declaredEnum = enumMatch[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

check('A1 the extracted enum matches the known adgen Ad.status lifecycle', () => {
  assert.deepStrictEqual(declaredEnum, ['queued', 'rendering', 'draft', 'live', 'archived', 'failed']);
});

// ═════════════════════════════════════════════════════════════════════════
// B — extract every literal `status: '<value>'` renderer.js WRITES (i.e.
// appears inside an object passed to Ad.updateOne/updateMany/findOneAndUpdate
// as part of a $set — not the claim filter's `status:'rendering'` READ).
// ═════════════════════════════════════════════════════════════════════════
function balanced(src, openIdx, openCh, closeCh) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === openCh) depth++;
    else if (src[i] === closeCh) { depth--; if (depth === 0) return src.slice(openIdx, i + 1); }
  }
  return null;
}
function splitTopLevelArgs(parenText) {
  const inner = parenText.slice(1, -1);
  const args = [];
  let depth = 0, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { args.push(inner.slice(start, i)); start = i + 1; }
  }
  args.push(inner.slice(start));
  return args.map((s) => s.trim());
}

const STRIPPED_RENDERER = stripComments(RENDERER_SRC);
const writtenStatusValues = new Set();
const CALL_RE = /Ad\.(updateOne|updateMany|findOneAndUpdate)\(/g;
let m;
while ((m = CALL_RE.exec(STRIPPED_RENDERER))) {
  const openParen = m.index + m[0].length - 1;
  const whole = balanced(STRIPPED_RENDERER, openParen, '(', ')');
  if (!whole) continue;
  const args = splitTopLevelArgs(whole);
  // The UPDATE document is arg[1] for updateOne/updateMany, and also arg[1]
  // for findOneAndUpdate (arg[0] is the filter in every case here).
  const updateArg = args[1] || '';
  for (const sm of updateArg.matchAll(/status:\s*['"]([\w-]+)['"]/g)) {
    writtenStatusValues.add(sm[1]);
  }
  CALL_RE.lastIndex = m.index + whole.length;
}

check('B0 the scan actually found written status literals (a zero-result scan proves nothing)', () => {
  assert.ok(writtenStatusValues.size > 0, 'expected at least one status: literal inside an update document');
});

console.log(`  (renderer.js writes these Ad.status values: ${[...writtenStatusValues].sort().join(', ')})`);

check('B1 every status value renderer.js WRITES is in models/Ad.js\'s declared enum', () => {
  const bad = [...writtenStatusValues].filter((v) => !declaredEnum.includes(v));
  assert.strictEqual(bad.length, 0, `renderer.js writes status value(s) not in the declared enum: ${bad.join(', ')}`);
});

check('B2 renderer.js never writes "queued" — that is expandWizardJob\'s job, not the renderer\'s', () => {
  assert.ok(!writtenStatusValues.has('queued'));
});

check('B3 renderer.js never writes "live" or "archived" — those are operator actions, not render outcomes', () => {
  assert.ok(!writtenStatusValues.has('live'));
  assert.ok(!writtenStatusValues.has('archived'));
});

check('B4 the only terminal outcomes renderer.js writes are draft (success) and failed (failure)', () => {
  const terminal = [...writtenStatusValues].filter((v) => v !== 'rendering');
  assert.deepStrictEqual(terminal.sort(), ['draft', 'failed']);
});

// ═════════════════════════════════════════════════════════════════════════
// C — cross-check every value renderer.js writes against the REAL switch
// case labels inside classifyRunAdOutcome (campaignRunGuards.js), so a
// value renderer.js writes can never silently fall into that switch's
// `default: break` (uncounted, invisible to reconciliation).
// ═════════════════════════════════════════════════════════════════════════
const switchMatch = /switch\s*\(\s*ad\s*&&\s*ad\.status\s*\)\s*\{/.exec(GUARDS_SRC);
assert.ok(switchMatch, 'classifyRunAdOutcome\'s switch shape changed — re-derive this harness');
const switchBody = balanced(GUARDS_SRC, GUARDS_SRC.indexOf('{', switchMatch.index + switchMatch[0].length - 1), '{', '}');
const recognisedCases = [...switchBody.matchAll(/case\s+['"]([\w-]+)['"]\s*:/g)].map((mm) => mm[1]);

check('C1 the switch actually has case labels (a zero-result scan proves nothing)', () => {
  assert.ok(recognisedCases.length >= 4, `expected several case labels, found ${recognisedCases.length}`);
});

console.log(`  (classifyRunAdOutcome recognises: ${recognisedCases.sort().join(', ')})`);

check('C2 every status value renderer.js writes is a case classifyRunAdOutcome recognises', () => {
  const invisible = [...writtenStatusValues].filter((v) => !recognisedCases.includes(v));
  assert.strictEqual(invisible.length, 0,
    `renderer.js writes status value(s) invisible to classifyRunAdOutcome's switch (would fall into ` +
    `the uncounted default branch): ${invisible.join(', ')}`);
});

check('C3 the declared Ad.status enum and classifyRunAdOutcome\'s recognised cases are the SAME SET', () => {
  // Not just "renderer.js's writes are covered" — the whole enum should be,
  // since any OTHER writer (adRegenerateService, titlingResumeService,
  // bootRecoveryService, ...) can also produce any of these six values and
  // classifyRunAdOutcome has to make sense of ALL of them, not just this
  // file's slice.
  assert.deepStrictEqual([...recognisedCases].sort(), [...declaredEnum].sort());
});

// ── report ───────────────────────────────────────────────────────────────
const total = checks + failures.length;
console.log('');
if (failures.length) {
  console.log(`❌ verifyRendererAdStatusEnum: ${failures.length} of ${total} checks FAILED`);
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
}
console.log(`✅ verifyRendererAdStatusEnum: ${total}/${total} checks passed`);

/*
 * REVERT-PROOF LEDGER — mutations that would make this harness fail:
 *   1. renderer.js writes status:'queued' or status:'live' anywhere
 *        → B1/B2/B3 fail
 *   2. renderer.js writes a status value not in Ad.js's enum (e.g. a typo
 *      like 'complete')                                → B1 fails
 *   3. campaignRunGuards.js's switch drops a case label that renderer.js
 *      still writes (e.g. removes `case 'failed':`)     → C2/C3 fail
 *   4. models/Ad.js's enum gains a value the switch doesn't handle, or
 *      vice versa                                        → C3 fails
 */
