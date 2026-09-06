'use strict';
//
// verifyShutdownReleaseReceiptAware — pins the money rule on renderer.shutdown()'s
// forced claim release.
//
// WHY THIS EXISTS. shutdown() releases claims so a peer can pick up work an
// instance replacement is about to kill. Releasing a `rendering` ad reproduces
// claimOne's filter exactly ({status:'rendering', claimedByWorker:null,
// renderRoute:{$in:['html_gen','veo']}}), so the peer re-enters renderVideo /
// renderStatic from the top and calls generateForAd again.
//
// UPDATED: generateForAd NOW has a resume-from-receipt guard
// (shouldResumeAttempt, atlasVideoService.js — pinned by
// scripts/verifyVideoResumeFromReceipt.js), so a re-entry that DOES slip past
// this file's own release guard is no longer an automatic double-bill on its
// own. This file still matters for the SAME reason it always did: shutdown's
// release is the other half of defense in depth — receiptFree() here stops a
// paid claim from being handed to a peer at all, so the resume guard in
// generateForAd is a backstop for paths THIS file cannot see (a future
// claim-TTL sweeper, a SIGKILL/OOM the shutdown handler never runs for), not
// a reason to relax the check here.
//
// services/spendReceipt.js states the rule: "a requeue may only ever touch
// RECEIPT-FREE ads." Backend enforces it with verifyReceiptAwareRequeue.js;
// adgen has no such harness, which is how an unguarded release reached master.
// This pins the one adgen site that needs it.
//
// Checks A/B are BEHAVIOURAL — they execute the real RECEIPT_FREE predicate
// against constructed documents through a matcher covering exactly the operators
// that object uses. A mutation that weakens the predicate itself goes red here
// without touching renderer.js.
//
// Check C is structural, but its scan window is bounded by shutdown()'s own
// brace-matched body rather than a magic character count, so it cannot drift
// stale as the file grows around it.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const { RECEIPT_FREE, HAS_RECEIPT } = require(path.join(ROOT, 'src/services/spendReceipt'));

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── minimal matcher: only the operators RECEIPT_FREE/HAS_RECEIPT actually use ──
function getPath(doc, p) {
  return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function matchClause(doc, key, cond) {
  if (key === '$and') return cond.every((c) => matches(doc, c));
  if (key === '$or') return cond.some((c) => matches(doc, c));
  const val = getPath(doc, key);
  if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === '$in') { if (!arg.some((a) => a === val || (a === null && val == null))) return false; }
      else if (op === '$nin') { if (arg.some((a) => a === val || (a === null && val == null))) return false; }
      else if (op === '$exists') { const present = getPath(doc, key) !== undefined; if (present !== arg) return false; }
      else throw new Error(`matcher: unsupported operator ${op} — extend the matcher, do not weaken the check`);
    }
    return true;
  }
  return val === cond;
}
function matches(doc, query) {
  return Object.entries(query).every(([k, v]) => matchClause(doc, k, v));
}

console.log('verifyShutdownReleaseReceiptAware\n');

// ── A. RECEIPT_FREE must EXCLUDE every shape of paid ad ──────────────────────
const paid = [
  { name: 'video receipt', doc: { veoPredictionId: 'pred_abc', imageGeneration: null } },
  { name: 'static receipt', doc: { veoPredictionId: null, imageGeneration: { predictionId: 'img_xyz' } } },
  { name: 'both receipts', doc: { veoPredictionId: 'p', imageGeneration: { predictionId: 'q' } } }
];
for (const c of paid) {
  ok(`A RECEIPT_FREE excludes a paid ad (${c.name})`, !matches(c.doc, RECEIPT_FREE),
     `RECEIPT_FREE matched ${JSON.stringify(c.doc)} — a paid ad would be released and re-submitted`);
  ok(`A HAS_RECEIPT includes a paid ad (${c.name})`, matches(c.doc, HAS_RECEIPT));
}

// ── B. RECEIPT_FREE must INCLUDE genuinely unbilled ads ──────────────────────
// If this over-tightens, the zombie-claim fix stops working entirely.
const unpaid = [
  { name: 'schema defaults (null)', doc: { veoPredictionId: null, imageGeneration: null } },
  { name: 'empty strings', doc: { veoPredictionId: '', imageGeneration: { predictionId: '' } } },
  { name: 'fields absent', doc: {} },
  { name: 'imageGeneration present, no predictionId', doc: { veoPredictionId: null, imageGeneration: { model: 'x' } } }
];
for (const c of unpaid) {
  ok(`B RECEIPT_FREE includes an unbilled ad (${c.name})`, matches(c.doc, RECEIPT_FREE),
     `RECEIPT_FREE rejected ${JSON.stringify(c.doc)} — receipt-free zombies would never be released`);
}

// ── C. the shutdown() release must actually apply it ─────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'src/services/renderer.js'), 'utf8');

// Brace-matched body of shutdown(), so the window tracks the function rather
// than a character offset that goes stale as the file grows.
function functionBody(text, signature) {
  const start = text.indexOf(signature);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}
// Strip comments before scanning. A negative check ("must NOT contain X") is
// defeated by any prose mentioning X — including this file's own explanation of
// why the spread is wrong, which is exactly what happened on the first run.
// Positive checks are stripped too, so a commented-out call cannot satisfy them.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (":" guard spares "https://")
}
const body = stripComments(functionBody(src, 'async function shutdown(') || '');
ok('C shutdown() found and brace-matched', !!body,
   'could not locate async function shutdown( — the harness window is stale, fix the harness');

if (body) {
  const releaseCalls = [...body.matchAll(/Ad\.updateMany\s*\(/g)];
  ok('C exactly one Ad.updateMany release in shutdown()', releaseCalls.length === 1,
     `found ${releaseCalls.length} — a second unguarded release would be invisible to the checks below`);

  ok('C the release applies the receipt guard via receiptFree()',
     /receiptFree\s*\(/.test(body),
     'the forced release does not apply the receipt guard — a paid ad can be handed to a peer and re-submitted');

  // A SPREAD IS A REAL DEFECT HERE, not a style preference. spendReceipt.js:
  // "Spread-merging would silently drop an existing `$and`". A spread works only
  // while the base filter has no $and of its own; the day someone adds one, the
  // guard vanishes silently. Pin the composer so that edit cannot pass.
  ok('C the release does NOT spread RECEIPT_FREE',
     !/\.\.\.\s*RECEIPT_FREE/.test(body),
     'spreading RECEIPT_FREE silently drops the guard if the base filter ever grows an $and — use receiptFree()');

  ok('C the guard is sourced from spendReceipt, not redefined locally',
     /require\(['"]\.\/spendReceipt['"]\)/.test(body) || /require\(['"]\.\/spendReceipt['"]\)/.test(src),
     'a local redefinition can drift from the single definition every other site uses');

  // D. BEHAVIOURAL: receiptFree() must preserve a pre-existing $and rather than
  // clobbering it — the exact failure a spread produces.
  const { receiptFree } = require(path.join(ROOT, 'src/services/spendReceipt'));
  const composed = receiptFree({ status: 'rendering', $and: [{ marker: 1 }] });
  ok('D receiptFree preserves a caller $and clause',
     Array.isArray(composed.$and) && composed.$and.some((c) => c.marker === 1),
     'receiptFree dropped the caller\'s own $and');
  ok('D receiptFree still excludes a paid ad when the caller supplied an $and',
     !matches({ status: 'rendering', marker: 1, veoPredictionId: 'pred_abc' }, composed),
     'composed filter matched a paid ad — the receipt guard was lost in composition');

  // The release must still be scoped to THIS worker and to rendering rows.
  ok('C the release is still scoped to this worker', /claimedByWorker:\s*WORKER_ID/.test(body));
  ok('C the release is still scoped to rendering rows', /status:\s*['"]rendering['"]/.test(body));
}

console.log('');
if (failed) {
  console.log(`❌ verifyShutdownReleaseReceiptAware: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('✅ verifyShutdownReleaseReceiptAware: all checks passed');
}
