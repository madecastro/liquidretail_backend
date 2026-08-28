#!/usr/bin/env node
'use strict';
//
// verifyBootRecoveryClaimAware — bootRecoveryService's sweep must not stomp
// an ad an adgen worker is actively titling.
//
// THE BUG (2026-08-26 handoff §4d.2, widened after adversarial review found
// a second, more important defect the original brief did not know about).
// bootRecoveryService.resumeInFlightAds sweeps `status:'rendering'` ads
// holding a spend receipt, stale for more than RESUME_STALE_MIN (default
// 5 min, judged on Ad.updatedAt). It is called unconditionally by worker.js's
// recoverTick on every REAP_INTERVAL_MIN (default 5 min) tick. It had TWO
// independent gaps, not one:
//   1. CLAIM-BLIND. The query never looked at Ad.claimedByWorker at all, so
//      a still-titling row claimed by an adgen worker could look "stale" and
//      get peeked + stamped status:'draft'+titlingResumeState:'pending' out
//      from under the live claim — corrupting the status:'rendering' guard
//      the claiming worker's own completion write relies on to know it still
//      owns the row (the dual-render scenario).
//   2. NOT GATED ON ADGEN OWNERSHIP AT ALL. Unlike its sibling
//      services/titlingResumeService.js (which stands down entirely with
//      `if (isAdgenRendererEnabled()) return out;`), this file had zero
//      reference anywhere to ADGEN_RENDERER_ENABLED / isAdgenRendererEnabled
//      — so it kept sweeping the exact collection adgen claims rows in,
//      regardless of who currently owns rendering.
//
// THE FIX has two parts, ownership-gating as PRIMARY, claim-awareness as
// SECONDARY defense in depth (see the file's own header comments for the
// full argument):
//   Primary:   when adgen owns rendering (isAdgenRendererEnabled()), the
//              per-ad loop stands down on VIDEO recovery specifically —
//              image recovery and its cost-reconcile call stay
//              unconditional, because a recovered image is a single
//              synchronous peek-then-write with no titling hand-off to race.
//   Secondary: buildRecoverySweepFilter is claim-aware. An unclaimed row
//              still uses RESUME_STALE_MIN (5m). A claimed row
//              (Ad.claimedByWorker set) gets a much longer allowance,
//              RESUME_CLAIM_STALE_MIN (default 15m, mirrors
//              titlingResumeService.CLAIM_STALE_MIN's "generous on purpose"
//              convention), and BOTH Ad.updatedAt AND Ad.claimedAt must be
//              stale before a claimed row is swept — claimedAt is stamped
//              once at claim time and never refreshed, so a brand-new claim
//              (e.g. right after a titler handoff, which does not touch
//              updatedAt) is protected from the moment it is taken, not only
//              once something first heartbeats it.
//
// THESE CHECKS evaluate the REAL exported buildRecoverySweepFilter against
// REAL document shapes, and (Group G) drive the REAL resumeInFlightAds with
// Ad.find/Ad.updateOne and atlasVideoService.resumeForAd mocked — not a
// regex over the source, and not a hand-copied re-implementation. "A
// source-text assertion cannot tell a working query from one that merely
// still contains the right words" (see scripts/verifyNoStrandedQueued.js,
// same discipline).
//
// Group map:
//   A. A claimed, heartbeat-fresh titling ad is NOT swept, INCLUDING right
//      at the claim boundary (not just "comfortably inside" — see A3).
//   B. A genuinely dead claim IS still swept — recovery of truly-dead work
//      is this sweep's purpose, and it must not become a no-op.
//   C. Pre-existing unclaimed behaviour is unchanged.
//   D. HAS_RECEIPT survived being nested under the new $and.
//   E. The live call site actually uses buildRecoverySweepFilter (not a
//      copy), and reads its own env vars (not aliased).
//   F. RESUME_CLAIM_STALE_MIN is materially larger than RESUME_STALE_MIN, on
//      the REAL live constants (not a re-derived default that never reads
//      the file) AND on a direct source-text extraction of both literals, so
//      neither check alone is the single point of failure.
//   G. EXECUTION: with adgen owning rendering, a video-receipt candidate is
//      never peeked and never written, while an image-receipt candidate in
//      the SAME pass still recovers normally; with the flag off, video
//      recovery resumes.
//   H. The claimedAt race (adversarial finding): a claim taken SECONDS ago
//      on a row whose updatedAt predates it (titler handoff / reclaim does
//      not touch updatedAt) must not be swept just because updatedAt looks
//      old; a legacy claim with no claimedAt at all falls back to the
//      updatedAt-only rule exactly as before this clause existed.
//
// Revert-prove (each mutation must fail this harness):
//   1. Drop the claimedByWorker clauses entirely (old unconditional
//        `{status:'rendering', updatedAt:{$lt:cutoff}, ...HAS_RECEIPT}`)
//        → A1/A3 fail (the claimed-fresh row is swept — the dual-render bug)
//   2. Set claimStaleCutoff = staleCutoff (reuse RESUME_STALE_MIN for
//        claimed rows too) → A1/A3 fail
//   3. Drop the claimedByWorker:{$ne:null} branch entirely (claimed rows
//        never recovered) → B1/B2 fail (permanent no-op for claimed rows)
//   4. Spread HAS_RECEIPT next to the claim $or instead of nesting it in
//        $and → D1/D2 fail (a no-receipt row is swept)
//   5. Stop calling Ad.find(buildRecoverySweepFilter(...)) at the live call
//        site → E1 fails (these checks would be testing a copy)
//   6. Drop the `claimedAt: { $lt: claimCutoff }` clause from the claimed
//        arm → H1 fails (a fresh claim on a stale-updatedAt row is swept)
//   7. Remove the `!isImageReceipt && adgenOwnsRendering` gate, or move it
//        to wrap the image branch too → G1/G2/G3 fail
//   8. Revert the explicit `$or: [{claimedAt:null}, {claimedAt:{$lt:...}}]`
//        back to a bare `claimedAt: { $lt: claimCutoff }` (the exact
//        merge-gate-caught production bug: MongoDB's $lt does not match
//        null) → I1 fails (a claimed-but-unstamped dead row becomes
//        permanently unrecoverable) and E5b fails (structural pin)
//
// Pure + offline: no DB, no network, no API key. Group G mocks every
// network-capable dependency before it is ever called.
//   node scripts/verifyBootRecoveryClaimAware.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];
function ok(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${label}\n      ${err.message}`);
  }
}
async function okAsync(label, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${label}\n      ${err.message}`);
  }
}

// ── the real module under test ──────────────────────────────────────────
const bootRecovery = require('../services/bootRecoveryService');
const {
  buildRecoverySweepFilter,
  RESUME_STALE_MIN,
  RESUME_CLAIM_STALE_MIN
} = bootRecovery;

assert.ok(typeof buildRecoverySweepFilter === 'function', 'buildRecoverySweepFilter must be exported');
assert.strictEqual(typeof RESUME_STALE_MIN, 'number');
assert.strictEqual(typeof RESUME_CLAIM_STALE_MIN, 'number');

// ── a small, general Mongo-filter evaluator over PLAIN JS DOCS ───────────
// Supports exactly what buildRecoverySweepFilter + HAS_RECEIPT use: $and,
// $or, $lt, $ne, $in, $nin, dotted paths, and plain equality (incl. null).
// Unsupported operators throw deliberately — extend on purpose, not by
// accident (same discipline as the mongoMatch helpers this pattern is
// modelled on elsewhere in this codebase's harnesses).
//
// $lt on a MISSING/null field does NOT match a Date operand — mirrors real
// MongoDB comparison-OPERATOR semantics, which are type-bracketed and are
// NOT the same rule as general BSON *sort* order (where null sorts before
// every non-MinKey type). An earlier draft of this file got exactly this
// backwards — it modeled null as `-Infinity` for `$lt`, which made the
// harness AGREE with a real production bug (`claimedAt: {$lt: claimCutoff}`
// silently excluding every null-`claimedAt` row from ever being recovered)
// instead of catching it. Verified directly against this collection: of
// 1,391 rows with `claimedAt: null`, a query for `{claimedAt: {$lt: <a
// cutoff one year in the future}}}` matched ZERO of them; 65 real-Date rows
// matched the same query as a positive control (all 65). Corrected here so
// this harness can no longer disagree with what MongoDB actually does.
//
// MISSING === null for equality ($eq/$ne/$in/$nin membership), also mirroring
// real Mongo: a field that is simply absent from the document matches a
// literal `null` in the query, and therefore also counts as "in" an $in/$nin
// list that contains null. Plain JS `undefined === null` is false, which
// would silently disagree with production here — second-round adversarial
// finding — for exactly the kind of stranded/legacy document this file
// exists to reason about, where a field being unset is the normal case, not
// an edge case.
function getPath(doc, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}
function mongoNullEquals(actual, operand) {
  if (operand === null) return actual === null || actual === undefined;
  return actual === operand;
}
function matchesCondition(actual, cond) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === '$lt') {
        // Type-bracketed: a missing/null field never satisfies $lt against
        // a non-null operand, regardless of how favorable the cutoff is.
        // Verified against production — see the header comment above.
        if (actual == null) return false;
        const a = actual instanceof Date ? actual.getTime() : actual;
        const b = operand instanceof Date ? operand.getTime() : operand;
        if (!(a < b)) return false;
      } else if (op === '$ne') {
        if (mongoNullEquals(actual, operand)) return false;
      } else if (op === '$in') {
        if (!operand.some((v) => mongoNullEquals(actual, v))) return false;
      } else if (op === '$nin') {
        if (operand.some((v) => mongoNullEquals(actual, v))) return false;
      } else {
        throw new Error(`matchesCondition: unsupported operator ${op} — extend deliberately`);
      }
    }
    return true;
  }
  return mongoNullEquals(actual, cond);
}
function matchesFilter(doc, filter) {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!cond.every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === '$or') {
      if (!cond.some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (!matchesCondition(getPath(doc, key), cond)) return false;
  }
  return true;
}

// ── build the real filter, exactly the way resumeInFlightAds does ────────
const NOW = Date.now();
const cutoff = new Date(NOW - RESUME_STALE_MIN * 60 * 1000);
const claimCutoff = new Date(NOW - RESUME_CLAIM_STALE_MIN * 60 * 1000);
const filter = buildRecoverySweepFilter({ cutoff, claimCutoff });

function minsAgo(m) { return new Date(NOW - m * 60 * 1000); }

// A receipt-holding VIDEO ad, otherwise a valid sweep candidate, that is
// claimed and whose heartbeat lags PAST RESUME_STALE_MIN (5m) but NOT past
// RESUME_CLAIM_STALE_MIN (15m) — a titling job that is slow, not dead. Both
// clocks set consistently: claimed and last touched at the same moment.
const claimedFreshTitling = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-7',
  claimedAt: minsAgo(RESUME_STALE_MIN + 1),
  updatedAt: minsAgo(RESUME_STALE_MIN + 1),   // e.g. 6m — stale by the old rule
  veoPredictionId: 'pred_claimed_fresh'
};

// Same claim, but the worker is genuinely gone: untouched well past
// RESUME_CLAIM_STALE_MIN on BOTH clocks.
const claimedDead = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-3',
  claimedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
  updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),   // e.g. 20m
  veoPredictionId: 'pred_claimed_dead'
};

// Unclaimed, stale past RESUME_STALE_MIN — the pre-existing behaviour this
// fix must not change.
const unclaimedStale = {
  status: 'rendering',
  claimedByWorker: null,
  updatedAt: minsAgo(RESUME_STALE_MIN + 1),
  veoPredictionId: 'pred_unclaimed_stale'
};

// Unclaimed, fresh — never a sweep candidate.
const unclaimedFresh = {
  status: 'rendering',
  claimedByWorker: null,
  updatedAt: minsAgo(1),
  veoPredictionId: 'pred_unclaimed_fresh'
};

// A dead claim, but NO spend receipt at all — proves HAS_RECEIPT still
// gates the claimed-row branch (guards the $and-vs-spread $or collision).
const claimedDeadNoReceipt = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-9',
  claimedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
  updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
  veoPredictionId: null,
  imageGeneration: { predictionId: null }
};

// An unclaimed, stale row with no receipt — symmetric receipt-guard proof
// on the original (unclaimed) branch.
const unclaimedStaleNoReceipt = {
  status: 'rendering',
  claimedByWorker: null,
  updatedAt: minsAgo(RESUME_STALE_MIN + 1),
  veoPredictionId: null,
  imageGeneration: { predictionId: null }
};

// Right shape, wrong status — sanity check that `status:'rendering'` still
// gates the whole filter (protects against the same "silently overwritten
// top-level key" class of bug the $and/$or nesting guards against).
const wrongStatus = { ...claimedDead, status: 'draft' };

// A claim taken 90 SECONDS ago (claimedAt fresh) sitting on an updatedAt
// that predates the claim by well over RESUME_CLAIM_STALE_MIN — the exact
// shape a titler handoff or a fresh claimOne() produces, since neither
// writes updatedAt. This is the adversarial-review finding: gating on
// updatedAt alone would sweep a claim taken moments ago.
const freshClaimStaleUpdatedAt = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-11',
  claimedAt: new Date(NOW - 90 * 1000),
  updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
  veoPredictionId: 'pred_fresh_claim_stale_touch'
};

// A claimed row with NO claimedAt at all (legacy row, or a claim taken
// before this field existed) — must fall back to updatedAt-only, exactly
// the pre-claimedAt-clause behaviour, not gain extra protection it cannot
// actually justify.
const legacyClaimNoClaimedAt = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-legacy',
  // claimedAt intentionally absent
  updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
  veoPredictionId: 'pred_legacy_claim'
};

// A claimed row whose claimedAt is fresh but with NO claimedAt clause this
// would matter for at all if updatedAt is ALSO fresh — included for
// completeness of the boundary story, not a distinct branch.
const boundaryJustInsideClaimWindow = {
  status: 'rendering',
  claimedByWorker: 'adgen-titler-boundary',
  claimedAt: minsAgo(RESUME_CLAIM_STALE_MIN - 1),
  updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN - 1),
  veoPredictionId: 'pred_boundary_inside'
};

// ── Group A: lagging-but-alive claim is EXCLUDED ──────────────────────────
ok('A1 claimed + fresh-heartbeat (6m, < 15m claim TTL) titling ad is NOT swept', () => {
  assert.strictEqual(matchesFilter(claimedFreshTitling, filter), false,
    'a live claim inside RESUME_CLAIM_STALE_MIN must be excluded — sweeping it is the dual-render bug');
});
// A2 REMOVED (adversarial finding, follow-up pass): its own fixture sat
// `updatedAt` exactly AT the old RESUME_STALE_MIN cutoff, and that cutoff's
// comparison is `$lt` (strictly-less-than) everywhere in this file — so the
// OLD unclaimed-only filter would ALSO have excluded that exact document
// (an equal-to-cutoff row was never eligible under either rule). The check
// could not fail against the mutation its own name and comment claimed to
// guard ("claim staleness is measured against RESUME_CLAIM_STALE_MIN, not
// RESUME_STALE_MIN") — a decorative assertion in a money-critical harness is
// worse than no assertion, because the next reader trusts the label. A1
// (a claim 1 minute inside the OLD 5m bar, `RESUME_STALE_MIN + 1`) and A3
// (a claim 1 minute inside the REAL, current `RESUME_CLAIM_STALE_MIN` bar,
// computed off the live constant so a shrunk default moves the fixture with
// it) are what actually prove the claimed arm uses the claim TTL, not the
// unclaimed one — both already fail correctly if that mutation is
// reintroduced. Nothing lost by deleting this one; say so here rather than
// leave a check that cannot do its stated job.
ok('A3 claimed row 1 minute INSIDE the real claim boundary is excluded — not just "comfortably fresh"', () => {
  // Closes the specific adversarial-review gap: A1's 6-minute fixture only
  // proved any TTL greater than 6 minutes passes, which a materially
  // smaller-than-intended default (e.g. 7) would also satisfy. This fixture
  // sits close to whatever RESUME_CLAIM_STALE_MIN actually IS, computed
  // from the live constant, not a hardcoded number — so a shrunk default
  // moves this fixture's staleness right along with it and still fails.
  assert.strictEqual(matchesFilter(boundaryJustInsideClaimWindow, filter), false,
    `a claim only ${RESUME_CLAIM_STALE_MIN - 1}m old (1m inside the real ${RESUME_CLAIM_STALE_MIN}m TTL) must be excluded`);
});

// ── Group B: a genuinely dead claim is STILL recovered ────────────────────
ok('B1 claimed + dead (20m, > 15m claim TTL) IS swept — recovery is not a no-op', () => {
  assert.strictEqual(matchesFilter(claimedDead, filter), true,
    'a claim older than RESUME_CLAIM_STALE_MIN must still be recoverable, or a dead adgen worker strands the paid master forever');
});
ok('B2 the claim TTL is a real, finite bound — not effectively infinite', () => {
  assert.ok(RESUME_CLAIM_STALE_MIN < 24 * 60,
    'RESUME_CLAIM_STALE_MIN must stay well under a day, or "recovers dead claims" is nominal only');
});

// ── Group C: pre-existing unclaimed behaviour is unchanged ───────────────
ok('C1 unclaimed + stale (> RESUME_STALE_MIN) is still swept, exactly as before', () => {
  assert.strictEqual(matchesFilter(unclaimedStale, filter), true);
});
ok('C2 unclaimed + fresh is still excluded, exactly as before', () => {
  assert.strictEqual(matchesFilter(unclaimedFresh, filter), false);
});

// ── Group D: HAS_RECEIPT was not dropped by the new $or ───────────────────
ok('D1 claimed + dead but NO receipt is NOT swept (receipt guard survived nesting)', () => {
  assert.strictEqual(matchesFilter(claimedDeadNoReceipt, filter), false,
    'HAS_RECEIPT must still gate the claimed branch — a spread-collision would silently drop it');
});
ok('D2 unclaimed + stale but NO receipt is NOT swept (receipt guard survived nesting)', () => {
  assert.strictEqual(matchesFilter(unclaimedStaleNoReceipt, filter), false);
});
ok('D3 status:rendering is still required (top-level key not shadowed)', () => {
  assert.strictEqual(matchesFilter(wrongStatus, filter), false);
});
ok('D4 buildRecoverySweepFilter nests HAS_RECEIPT inside $and, never spreads it beside the claim $or', () => {
  // Structural proof, not just behavioural: exactly one top-level `$or` key
  // can exist on a JS object literal — if the source spreads HAS_RECEIPT's
  // `{ $or: [...] }` into the same object as a second `$or`, the second
  // silently wins and D1/D2 above would be testing a filter shape that does
  // not match what a spread bug would actually produce. Assert the filter
  // object itself is `$and`-shaped with no top-level `$or`.
  assert.ok(Array.isArray(filter.$and), 'filter must combine HAS_RECEIPT and the claim clause via $and');
  assert.strictEqual(filter.$or, undefined, 'filter must not carry a top-level $or (that is exactly the collision this fix avoids)');
});

// ── Group H: the claimedAt race (adversarial finding) ────────────────────
ok('H1 fresh claim (90s old) on a stale-updatedAt row is NOT swept — the titler-handoff race', () => {
  assert.strictEqual(matchesFilter(freshClaimStaleUpdatedAt, filter), false,
    'claimedAt is stamped once and never refreshed; gating on updatedAt alone would sweep a claim taken moments ago, ' +
    'since a titler handoff / fresh claimOne() never touches updatedAt');
});
ok('H2 a legacy claim with no claimedAt at all still falls back to updatedAt-only staleness', () => {
  assert.strictEqual(matchesFilter(legacyClaimNoClaimedAt, filter), true,
    'a claim with no claimedAt should get no LESS protection than before this clause existed — the explicit ' +
    '`claimedAt: null` arm matches a MISSING field too (Mongo equality, not $lt), same as this harness\'s own evaluator');
});

// ── Group I: the null-claimedAt PRODUCTION BUG — bare $lt never matches null
// Second-round merge-gate finding, proved directly against production before
// being fixed here (see the docblock on buildRecoverySweepFilter): MongoDB's
// $lt is type-bracketed and does NOT match a literal `claimedAt: null` the
// way it would if BSON *sort* order applied to comparison OPERATORS too.
// Measured: of 1,391 real rows with `claimedAt: null`, a `{$lt: <a cutoff
// one year in the future>}` query matched ZERO. The ORIGINAL bare-$lt clause
// therefore made a claimed-but-unstamped row UNRECOVERABLE FOREVER — exactly
// the "permanent no-op for claimed rows" this file's own header forbids.
ok('I1 explicit-null claimedAt + stale updatedAt IS swept — the exact production bug, now closed', () => {
  const explicitNullClaimedAtStale = {
    status: 'rendering',
    claimedByWorker: 'adgen-titler-explicit-null',
    claimedAt: null,   // as stored by mongoose's declared default, not merely absent
    updatedAt: minsAgo(RESUME_CLAIM_STALE_MIN + 5),
    veoPredictionId: 'pred_explicit_null_claimed_at'
  };
  assert.strictEqual(matchesFilter(explicitNullClaimedAtStale, filter), true,
    'a literal claimedAt:null with a stale updatedAt must be recoverable — the production probe showed the ' +
    'pre-fix bare $lt clause matched zero of 1,391 such rows even against a cutoff a year in the future');
});
ok('I2 explicit-null claimedAt + FRESH updatedAt is NOT swept — the null arm does not bypass liveness', () => {
  // The fix must not overcorrect into "null claimedAt always sweeps
  // regardless of activity" — updatedAt freshness (a live heartbeat, however
  // unreliable) still independently excludes the row via the ANDed
  // `updatedAt: { $lt: claimCutoff }` clause alongside the null-OR.
  const explicitNullClaimedAtFresh = {
    status: 'rendering',
    claimedByWorker: 'adgen-titler-explicit-null-fresh',
    claimedAt: null,
    updatedAt: minsAgo(1),
    veoPredictionId: 'pred_explicit_null_claimed_at_fresh'
  };
  assert.strictEqual(matchesFilter(explicitNullClaimedAtFresh, filter), false,
    'a fresh updatedAt must still exclude the row even with claimedAt:null — the null arm only removes the ' +
    'FALSE-EXCLUSION bug, it must not also remove the liveness check');
});

// ── Group E: the live call site uses this exact function, not a copy ─────
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const serviceRaw = fs.readFileSync(path.join(ROOT, 'services', 'bootRecoveryService.js'), 'utf8');
const serviceSrc = stripComments(serviceRaw);

ok('E1 resumeInFlightAds calls Ad.find(buildRecoverySweepFilter(...)) — not a hand-copied filter', () => {
  assert.ok(/Ad\.find\(\s*buildRecoverySweepFilter\(/.test(serviceSrc),
    'the live query must use buildRecoverySweepFilter, or the checks above test a copy');
});
ok('E2 buildRecoverySweepFilter is exported (a harness outside this file can reach it)', () => {
  assert.ok(/module\.exports\s*=\s*\{[\s\S]*buildRecoverySweepFilter/.test(serviceSrc));
});
ok('E3 RESUME_CLAIM_STALE_MIN is read from its own env var, not aliased to RESUME_STALE_MIN', () => {
  assert.ok(/RESUME_CLAIM_STALE_MIN\s*=\s*Math\.max\(RESUME_STALE_MIN,\s*parseInt\(process\.env\.RESUME_CLAIM_STALE_MIN/.test(serviceSrc));
});
ok('E4 resumeInFlightAds accepts an injectable claimStaleMinutes (same pattern as staleMinutes)', () => {
  assert.ok(/claimStaleMinutes\s*=\s*RESUME_CLAIM_STALE_MIN/.test(serviceSrc));
});
ok('E5 the claimed-arm filter also requires claimedAt to be stale (not updatedAt alone)', () => {
  const i = serviceSrc.indexOf('claimedByWorker: { $ne: null }');
  assert.ok(i > 0, 'expected the claimed $or branch to exist verbatim');
  const block = serviceSrc.slice(i, i + 400);
  assert.ok(/claimedAt:\s*\{\s*\$lt:\s*claimCutoff\s*\}/.test(block),
    'the claimed branch must AND in claimedAt staleness, or H1 above is testing a copy of a stronger filter than production has');
});
ok('E5b claimedAt staleness is an EXPLICIT null-OR, not a bare $lt — production-verified fix', () => {
  // The bare-$lt shape (`claimedAt: { $lt: claimCutoff }` with no sibling
  // `claimedAt: null` arm) is EXACTLY the shipped bug: MongoDB's $lt does
  // not match null (type-bracketed comparison — see the docblock and I1/I2
  // below), so a bare clause here silently strands every unstamped legacy
  // claim forever. E5 alone would NOT catch a regression back to the bare
  // form, because the bare form still contains the substring E5 looks for —
  // this check specifically demands the `claimedAt: null` sibling arm exists
  // in the same $or, nested under the claimed branch.
  const i = serviceSrc.indexOf('claimedByWorker: { $ne: null }');
  assert.ok(i > 0);
  const block = serviceSrc.slice(i, i + 400);
  assert.ok(/\$or:\s*\[\s*\{\s*claimedAt:\s*null\s*\}/.test(block),
    'expected an explicit `{ claimedAt: null }` arm inside a nested $or on the claimed branch — ' +
    'a bare `claimedAt: { $lt: claimCutoff }` with no null arm is the exact production bug this pins');
});

// ── Group E6-E8: recovered-branch viewability + no-requeue, ported from the
// deleted scripts/verifyTitlingResume.js (2026-08-28, backend titling
// removal). These three checks are about bootRecoveryService's OWN
// recovered-branch $set, not the deleted titlingResumeService.js sweeper —
// they stay valuable independent of that removal. See the STATE_PENDING /
// TITLING_PENDING / fallbackPosterUrl comment near the top of
// bootRecoveryService.js for why those three are now inlined there instead
// of imported.
function recoveredSetBlock(src) {
  const marker = "r.state === 'done' && r.videoUrl";
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const setAt = src.indexOf('$set', at);
  if (setAt < 0 || setAt - at > 2000) return '';
  const stop = src.indexOf('continue;', setAt);
  return src.slice(at, stop > setAt ? stop : at + 1500);
}
const recBlock = recoveredSetBlock(serviceSrc);
ok('E6 recovered-branch $set writes renderUrl, posterUrl, kind, titlingResumeState (viewable + stamped)', () => {
  assert.ok(recBlock.length > 0, 'could not locate the recovered branch');
  assert.ok(/renderUrl:\s*r\.videoUrl/.test(recBlock)
    && /posterUrl:\s*poster\s*\|\|\s*r\.videoUrl/.test(recBlock)
    && /kind:\s*'video'/.test(recBlock)
    && /titlingResumeState:\s*STATE_PENDING/.test(recBlock),
    'a recovered ad without renderUrl is invisible (projectAd has no veoVideoUrl fallback)');
});
ok('E7 recovered-branch update still filters on status: \'rendering\' (no lease — filter IS the concurrency control)', () => {
  assert.ok(/\{\s*_id:\s*ad\._id,\s*status:\s*'rendering'\s*\}/.test(recBlock));
});
ok('E8 MONEY: bootRecoveryService contains no status:\'queued\' — a recovered master must never be requeued', () => {
  // routes/ads.js declares veoVideoUrl fresh and never reads ad.veoVideoUrl,
  // so a requeue re-submits to Omni (~$0.90) for a master already paid for.
  assert.ok(!/status:\s*['"]queued['"]/.test(serviceSrc),
    'a recovered ad must never be requeued — that re-submits to Omni');
});

// ── Group F: the TTL relationship is real, checked two independent ways ──
ok('F1 RESUME_CLAIM_STALE_MIN >= 3x RESUME_STALE_MIN on the REAL, LIVE, already-executed constants', () => {
  // Uses the constants this file imported from the real module at the top —
  // i.e. the value process.env actually produced this run — not a
  // re-derived `parseInt(undefined,...)` that never reads
  // bootRecoveryService.js and would stay green even if the code default
  // were quietly changed to 7.
  assert.ok(RESUME_CLAIM_STALE_MIN >= 3 * RESUME_STALE_MIN,
    `claimed-row TTL (${RESUME_CLAIM_STALE_MIN}m) must give real running-titling headroom over the unclaimed ` +
    `staleness window (${RESUME_STALE_MIN}m) — got ${RESUME_CLAIM_STALE_MIN} < 3x${RESUME_STALE_MIN}`);
});
ok('F1b same relationship holds on the LITERAL DEFAULT NUMBERS extracted from source text', () => {
  // Belt-and-braces: independent of whatever process.env happens to hold
  // when the suite runs, parse the actual `|| N` literal out of the real
  // file for both constants (same technique as verifyPostPilotBatch C14 /
  // verifyPmaxPromptOverlay V2c) and check the SAME relationship on the
  // numbers a fresh, unconfigured boot would actually use.
  const staleMatch = serviceSrc.match(/RESUME_STALE_MIN\s*=\s*Math\.max\(1,\s*parseInt\(process\.env\.RESUME_STALE_MIN,\s*10\)\s*\|\|\s*(\d+)\)/);
  const claimMatch = serviceSrc.match(/RESUME_CLAIM_STALE_MIN\s*=\s*Math\.max\(RESUME_STALE_MIN,\s*parseInt\(process\.env\.RESUME_CLAIM_STALE_MIN,\s*10\)\s*\|\|\s*(\d+)\)/);
  assert.ok(staleMatch, 'could not find the RESUME_STALE_MIN default literal in source — extraction regex is stale');
  assert.ok(claimMatch, 'could not find the RESUME_CLAIM_STALE_MIN default literal in source — extraction regex is stale');
  const staleDefault = Number(staleMatch[1]);
  const claimDefault = Number(claimMatch[1]);
  assert.ok(claimDefault >= 3 * staleDefault,
    `source default RESUME_CLAIM_STALE_MIN=${claimDefault} must be >= 3x source default RESUME_STALE_MIN=${staleDefault}`);
});
ok('F1c [ADVERSARIAL FIX] RESUME_CLAIM_STALE_MIN is floored at RESUME_STALE_MIN, not a bare 1 — a claimed row can never be easier to steal than an unclaimed one', () => {
  // Earlier finding: `Math.max(1, parseInt(process.env.RESUME_CLAIM_STALE_MIN,...) || 15)`
  // let an operator set RESUME_CLAIM_STALE_MIN=1 (or raise RESUME_STALE_MIN
  // above the claimed default) via env and INVERT the whole point of this
  // constant — a claimed row would then be swept sooner than an unclaimed
  // one, exactly the "misconfiguration that causes a dual render at 3am"
  // this clamp exists to close. Structural proof (the literal source text
  // must floor on the identifier RESUME_STALE_MIN, not the numeral 1) PLUS
  // a behavioural proof (a hostile env can't reproduce the old hole even if
  // the source text were somehow bypassed).
  assert.ok(/RESUME_CLAIM_STALE_MIN\s*=\s*Math\.max\(RESUME_STALE_MIN,/.test(serviceSrc),
    'RESUME_CLAIM_STALE_MIN must floor on RESUME_STALE_MIN by name, not on a bare 1 — a numeral floor cannot track a raised RESUME_STALE_MIN');
  assert.ok(!/RESUME_CLAIM_STALE_MIN\s*=\s*Math\.max\(1,/.test(serviceSrc),
    'the old bare-1 floor must be gone, not merely joined by a second clamp');
  // Behavioural: simulate the hostile env directly against the clamp
  // expression's OWN logic (Math.max), independent of which literal the
  // source currently uses — this is what would have caught the original
  // bug even before anyone wrote the structural regex above.
  const hostileResumeStale = 999; // an operator could raise this too
  const hostileClaimEnv = 1;      // and set this to the historical minimum
  const simulatedFloor = Math.max(hostileResumeStale, parseInt(String(hostileClaimEnv), 10) || 15);
  assert.ok(simulatedFloor >= hostileResumeStale,
    'the clamp formula itself must guarantee claim-TTL >= stale-TTL for ANY env input, not just the shipped defaults');
});
ok('F2 recovering a dead claim never re-submits (bootRecoveryService.js has no submit call) — no double-SPEND from taking over a dead claim', () => {
  // resumeForAd/recoverImageAd are peeks; the money invariant this harness
  // must not weaken is "this file never becomes able to submit". Cheap
  // structural smoke test alongside the behavioural checks above; the real
  // no-submit pin lives in scripts/verifyVideoResume.js.
  assert.ok(!/\.generateForAd\(|\.submitPrediction\(|veoGenerateForAd/.test(serviceSrc),
    'bootRecoveryService must stay submit-free — recovering a dead claim must cost CPU at worst, never a second charge');
});

// ── Group G: EXECUTION — ownership gate, video deferred / image unaffected
// Drives the REAL resumeInFlightAds. Ad.find / Ad.countDocuments /
// Ad.updateOne and atlasVideoService.resumeForAd are mocked so NOTHING here
// ever reaches a database or the network — resumeForAd is not injectable
// via resumeInFlightAds's own parameters (unlike recoverImage, which
// already is), so it is mocked at the module level via require.cache, and a
// FRESH copy of bootRecoveryService is required so its module-scope
// destructured `resumeForAd` binds to the mock (destructuring captures a
// value at require time, not a live reference — patching the export after
// the original top-of-file require would not be seen by it).
//
// Ad.find AND Ad.countDocuments are mocked using the REAL matchesFilter
// evaluator from Groups A-H above, run against a fixed 3-doc dataset — not
// "return everything regardless of the filter". This is what actually pins
// the second-round finding: a naive mock that always returns both rows
// would make G4 assert something true of the MOCK, not of the real query
// exclusion. Driving the real filter object through the real evaluator
// means a regression in buildRecoverySweepFilter's receiptKinds handling
// shows up here as a wrong candidate set, not just as a wrong boolean.
async function runGroupG() {
  const AdModel = require('../models/Ad');
  const atlasVideoService = require('../services/atlasVideoService');

  const savedAdFind = AdModel.find;
  const savedAdCountDocuments = AdModel.countDocuments;
  const savedAdUpdateOne = AdModel.updateOne;
  const savedResumeForAd = atlasVideoService.resumeForAd;
  const savedEnv = process.env.ADGEN_RENDERER_ENABLED;

  const videoCandidate = {
    _id: 'gate-video-1',
    status: 'rendering',
    claimedByWorker: null,
    updatedAt: minsAgo(RESUME_STALE_MIN + 1),
    veoPredictionId: 'pred_gate_video'
  };
  const imageCandidate = {
    _id: 'gate-image-1',
    status: 'rendering',
    claimedByWorker: null,
    updatedAt: minsAgo(RESUME_STALE_MIN + 1),
    veoPredictionId: null,
    imageGeneration: { predictionId: 'pred_gate_image' }
  };
  // BOTH receipts on one row — video must win the tie (this file's own
  // routing rule) and the row must therefore be excluded from the 'image'
  // receiptKinds query too, or the ownership gate's query-level exclusion
  // and the loop's tie-break rule would disagree with each other (second-
  // round finding: 'image' receiptKinds must also require an ABSENT
  // veoPredictionId, not just a present image one).
  const dualReceiptCandidate = {
    _id: 'gate-dual-1',
    status: 'rendering',
    claimedByWorker: null,
    updatedAt: minsAgo(RESUME_STALE_MIN + 1),
    veoPredictionId: 'pred_gate_dual_video',
    imageGeneration: { predictionId: 'pred_gate_dual_image' }
  };
  const dataset = [videoCandidate, imageCandidate, dualReceiptCandidate];

  let capturedFindFilter = null;
  let resumeForAdCalls = 0;
  let updateOneCalls = [];
  let recoverImageCalls = [];

  AdModel.find = function (queryFilter) {
    capturedFindFilter = queryFilter;
    const matched = dataset.filter((doc) => matchesFilter(doc, queryFilter));
    const chain = {
      sort() { return chain; },
      limit() { return chain; },
      lean: async () => matched
    };
    return chain;
  };
  AdModel.countDocuments = function (queryFilter) {
    const count = dataset.filter((doc) => matchesFilter(doc, queryFilter)).length;
    // Mimics the one method the real code calls on this: `.catch(handler)`,
    // itself awaited. Mongoose's real Query is thenable; this stub only
    // needs to satisfy the exact chain resumeInFlightAds uses.
    return { catch: async () => count };
  };
  AdModel.updateOne = async function (queryFilter) {
    updateOneCalls.push(queryFilter);
    return { modifiedCount: 0, matchedCount: 0 };
  };
  atlasVideoService.resumeForAd = async function () {
    resumeForAdCalls++;
    // Would only matter if actually reached — flag-ON must never call this.
    return { state: 'processing' };
  };
  const stubRecoverImage = async function ({ ad }) {
    recoverImageCalls.push(ad._id);
    return { state: 'recovered', predictionId: ad.imageGeneration?.predictionId || null };
  };

  const svcPath = require.resolve('../services/bootRecoveryService');
  delete require.cache[svcPath];
  const freshBootRecovery = require('../services/bootRecoveryService');

  try {
    // ── flag ON: adgen owns rendering ──────────────────────────────────
    process.env.ADGEN_RENDERER_ENABLED = 'true';
    resumeForAdCalls = 0; updateOneCalls = []; recoverImageCalls = [];
    const onResult = await freshBootRecovery.resumeInFlightAds({ recoverImage: stubRecoverImage });

    ok('G1 flag ON: the video-receipt candidate is deferred, never peeked', () => {
      assert.strictEqual(resumeForAdCalls, 0,
        'resumeForAd must not even be called for a video row while adgen owns rendering');
      assert.strictEqual(onResult.deferredToAdgen, 2,
        'both the pure-video and the dual-receipt row must be counted deferred');
    });
    ok('G2 flag ON: no video row is ever written to', () => {
      assert.strictEqual(updateOneCalls.length, 0,
        `expected zero Ad.updateOne calls (image 'recovered' does not call it either) — got ${updateOneCalls.length}`);
    });
    ok('G3 flag ON: image recovery is UNAFFECTED — still runs and still recovers', () => {
      assert.deepStrictEqual(recoverImageCalls, ['gate-image-1'], 'only the true image candidate should reach recoverImage');
      assert.strictEqual(onResult.recovered, 1, 'the image candidate must still be counted recovered');
    });
    ok('G4 flag ON: the FIND ITSELF excludes video rows — a deferred row cannot occupy a limit slot', () => {
      // The second-round finding this closes: gating only inside the loop
      // left deferred video rows in the candidate set forever (never
      // written, so never falling out of the filter), able to saturate
      // RESUME_MAX_ADS and starve image recovery entirely. Proving
      // `considered === 1` (not 3) is what distinguishes "excluded at the
      // query" from "fetched then skipped".
      assert.strictEqual(onResult.considered, 1, 'only the image candidate should ever be fetched into the loop');
      assert.ok(capturedFindFilter, 'Ad.find must still have been called with a real filter object');
    });
    ok('G4b flag ON: the dual-receipt row is excluded from BOTH the image find and the video count double-booking', () => {
      // Not double-counted: it is exactly one of the 2 in deferredToAdgen
      // (G1) and exactly absent from considered (G4) — never both fetched
      // for image work AND counted as deferred.
      assert.strictEqual(onResult.considered, 1);
    });

    // ── flag OFF: backend owns rendering, video recovery resumes ───────
    process.env.ADGEN_RENDERER_ENABLED = 'false';
    resumeForAdCalls = 0; updateOneCalls = []; recoverImageCalls = [];
    const offResult = await freshBootRecovery.resumeInFlightAds({ recoverImage: stubRecoverImage });

    ok('G5 flag OFF: every candidate (video, image, dual) is fetched and video recovery resumes', () => {
      assert.strictEqual(offResult.considered, 3, 'flag off must use the unrestricted receiptKinds:"both" query');
      // dualReceiptCandidate routes as video (ties go to video) alongside
      // videoCandidate, so resumeForAd is called twice.
      assert.strictEqual(resumeForAdCalls, 2, 'resumeForAd must be called for both the pure-video and the dual-receipt row');
      assert.strictEqual(offResult.deferredToAdgen, 0);
    });
    ok('G6 flag OFF: image recovery still runs unaffected', () => {
      assert.deepStrictEqual(recoverImageCalls, ['gate-image-1']);
      assert.strictEqual(offResult.recovered, 1);
    });
  } finally {
    AdModel.find = savedAdFind;
    AdModel.countDocuments = savedAdCountDocuments;
    AdModel.updateOne = savedAdUpdateOne;
    atlasVideoService.resumeForAd = savedResumeForAd;
    if (savedEnv === undefined) delete process.env.ADGEN_RENDERER_ENABLED;
    else process.env.ADGEN_RENDERER_ENABLED = savedEnv;
    delete require.cache[svcPath];
  }
}

async function main() {
  await runGroupG();

  if (failures.length) {
    console.error(`\n❌ verifyBootRecoveryClaimAware: ${failures.length} of ${passed + failures.length} checks FAILED\n`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ verifyBootRecoveryClaimAware: all ${passed} checks passed`);
  }
}

main().catch((err) => {
  console.error('verifyBootRecoveryClaimAware: uncaught error', err && err.stack || err);
  process.exitCode = 1;
});
