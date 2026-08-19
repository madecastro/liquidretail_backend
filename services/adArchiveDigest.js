'use strict';
//
// ARCHIVE AN AD AND RELEASE ITS IDENTITY DIGEST — one definition, imported by
// every archive site. Do NOT re-implement per caller: a per-caller copy is
// exactly how the `resolveDeriveFromMaster` regenerate hole opened (CLAUDE.md
// §4), and a call site that used `receiptFree` WITHOUT importing it shipped a
// broken money guard to production three times (CLAUDE.md §5).
//
// ── THE DEFECT THIS CLOSES (diagnosed 2026-08-18) ────────────────────────
// `adSchema.index({ campaignId: 1, identityDigest: 1 }, { unique: true })` is
// NOT partial — MongoDB's partialFilterExpression cannot express
// `status != 'archived'`. So an archived row keeps occupying its identity
// slot forever.
//
// That is fatal for VIDEO specifically. `computeDeterministicVideoDigest`
// deliberately omits `generationRunId` (CLAUDE.md §2 — that omission IS the
// money guard that stops a repeat Generate re-billing a PAID Omni master).
// The consequence: once a NEVER-BILLED leftover video row is archived — by
// the Stop handler or by the 24h queuedArchiveSweeper — a repeat Generate's
// `insertMany` collides on the unique index, the 11000 is swallowed, and that
// video identity can never be minted again. Static self-heals (its digest is
// scoped to `generationRunId`); video does not.
//
// ── THE MONEY ANALYSIS — read this before changing anything here ─────────
// Freeing an archived row's digest is safe ONLY because the row is proven
// RECEIPT-FREE with NO renderUrl: it was never billed and nothing was ever
// delivered, so there is no paid identity to protect. The unique index's job
// is to stop a PAID identity being re-bought. A never-billed identity SHOULD
// be re-mintable — refusing to re-mint it is the bug.
//
// The guard is therefore enforced PER DOCUMENT, inside the update itself
// (`DIGEST_RELEASABLE`), not only in the caller's filter. That matters because
// some archive sites legitimately archive DELIVERED work — the operator
// PATCHing a live ad to 'archived', `ad.archive` / `ad.bulkArchive` from chat.
// Those rows are archived normally and KEEP their digest: a paid identity's
// slot is never released. Callers whose rows are inert by construction (the
// sweeper, both Stop writes) ALSO carry receipt-free + renderUrl-empty in
// their own filter — defense in depth, same pattern as #189 / #204.
//
// ── WHY AN AGGREGATION PIPELINE ──────────────────────────────────────────
// The tombstone has to be derived from EACH ROW's own `_id`, so a plain `$set`
// cannot express it (one literal value would collide across every row it
// touched — the opposite of the fix). `updateMany(filter, [ { $set: … } ])`
// evaluates per document and is atomic per document. Verified against the
// vendored mongoose 7.8.7: both `updateMany` and `findOneAndUpdate` pass an
// array update through to the server untouched (no cast, no mangling).
//
// All expressions inside ONE `$set` stage are evaluated against the stage's
// INPUT document, so `preArchiveIdentityDigest: '$identityDigest'` sees the
// ORIGINAL digest even though the same stage overwrites `identityDigest`.
// That is load-bearing — splitting these into two stages would save the
// tombstone instead of the real digest.
//
// ── THE TOMBSTONE ────────────────────────────────────────────────────────
// `archived:<_id>` — unique BY CONSTRUCTION (one `_id` per document), so the
// unique index can never reject the archive write itself. A random value or a
// null would not do: null is a real value to a non-sparse unique index and the
// second archived row on a campaign would fail.

// THE spend-receipt helper. Do not re-implement — a call site that used this
// without importing it shipped a broken money guard to production three times
// (CLAUDE.md §5). `npm run lint`'s no-undef is the net.
const { receiptFree } = require('./spendReceipt');

/** Prefix that marks a released (tombstoned) identity digest. */
const TOMBSTONE_PREFIX = 'archived:';

/** Human-readable 409 text when a restore cannot reclaim its digest. */
const DIGEST_COLLISION_MESSAGE =
  'cannot restore: this ad\'s identity was re-created by a later generation while it was archived. ' +
  'The newer ad holds the identity slot. Archive or delete that one first, or leave this ad archived.';

const tombstoneFor = (id) => `${TOMBSTONE_PREFIX}${String(id)}`;
const isTombstoneDigest = (v) => typeof v === 'string' && v.startsWith(TOMBSTONE_PREFIX);

// `$ifNull` maps BOTH null and a missing path to '', which is what makes this
// correct for `veoPredictionId` (schema default null, so `$exists:false` would
// match almost nothing — the same trap spendReceipt.js documents) and for
// `imageGeneration.predictionId` (parent is Mixed and often null).
const isEmptyExpr = (path) => ({ $eq: [{ $ifNull: [path, ''] }, ''] });

const startsWithTombstoneExpr = {
  $eq: [
    { $substrCP: [{ $ifNull: ['$identityDigest', ''] }, 0, TOMBSTONE_PREFIX.length] },
    TOMBSTONE_PREFIX
  ]
};

/**
 * MONEY GATE, per document. True only for a row that was never billed and
 * never delivered — the only shape whose identity slot may be freed.
 *
 * Mirrors services/spendReceipt.js RECEIPT_FREE in aggregation form. It is
 * NOT a substitute for importing `receiptFree()` in the caller's filter; it is
 * the second layer, and it is the one that protects the sites which must be
 * able to archive paid work (operator PATCH, ad.archive, ad.bulkArchive).
 *
 * The last clause is the NO-DOUBLE-WRAP guard: a row already carrying a
 * tombstone must never be re-wrapped, or `preArchiveIdentityDigest` would be
 * overwritten with `archived:<id>` and the real digest lost forever.
 */
// STATIC RECEIPT, fail-closed on a surprising parent. `imageGeneration` is
// Mixed. If it were ever a string or an array, `$imageGeneration.predictionId`
// resolves to MISSING (or to an array) and a bare emptiness test would read a
// real receipt as "no receipt" and free a paid identity. So the parent must be
// null/absent, or an object whose predictionId is empty. Anything else refuses.
// Deliberately STRICTER than services/spendReceipt.js's query-side clause —
// this expression can only ever fail closed, and it guards a digest release.
const STATIC_RECEIPT_FREE = {
  $or: [
    { $in: [{ $type: '$imageGeneration' }, ['missing', 'null']] },
    {
      $and: [
        { $eq: [{ $type: '$imageGeneration' }, 'object'] },
        isEmptyExpr('$imageGeneration.predictionId')
      ]
    }
  ]
};

// NEVER ENTERED A RENDER. Three markers, in descending order of trust,
// because "receipt-free" alone cannot see a render that was BILLED and then
// CRASHED before the receipt was persisted (services/spendReceipt.js's
// irreducible window: providers charge at SUBMIT, the receipt is written after
// the POST returns).
//
// ⚠️ CORRECTED 2026-08-18 by adversarial review. An earlier version of this
// comment claimed that window "is only reachable while status:'rendering'".
// THAT WAS FALSE, and it was the load-bearing claim under the whole design.
// Every rendering→queued REQUEUE site moves exactly such a row out of
// 'rendering' with no receipt wait — worker.js's 15-minute reaper,
// processAlerts' SIGTERM orphan persist, /generate's and /runs' crash
// handlers, claimAdsForRun's CLAIM ANOMALY release, and /generate's CAS-lost
// release. Post-requeue the row is `queued` + receipt-free + renderAttempts 0,
// so NOT_RENDERING no longer applies to it at all.
//
//   wasRendering   — THE DURABLE ONE, and the only one that survives the
//                    crash it exists for. Set by each requeue site's own
//                    AWAITED write (models/Ad.js declares it). Absent on a
//                    mint leftover that was never claimed, which is exactly
//                    the population whose digest we want to free.
//   renderAttempts — $inc'd when a render ENDS, so a crash mid-submit leaves
//                    it at 0. Useful, not sufficient.
//   renderStage    — BEST EFFORT ONLY. services/adStage.js is fire-and-forget
//                    BY CONTRACT (never awaited, failures swallowed, "a stage
//                    can be missed under load"), and /generate's CAS-lost
//                    release deliberately NULLS it. Keep it as belt-and-braces
//                    — it catches rows requeued BEFORE wasRendering shipped —
//                    but never rely on it alone.
//
// ACCEPTED RESIDUAL: rows requeued before this deploy carry no wasRendering
// and fall back to renderStage alone. A historical sliver that shrinks to zero
// for new rows; not worth a migration, and the failure mode needs a lost
// telemetry write inside a seconds-wide window.
//
// None of these is load-bearing for the correctness of the ARCHIVE; they only
// narrow WHEN a digest may be freed. Over-refusing costs a squatted identity
// slot. Under-refusing costs a re-bought Omni master. Refuse.
const NEVER_RENDERED = {
  $and: [
    { $ne: ['$wasRendering', true] },
    { $in: [{ $ifNull: ['$renderAttempts', 0] }, [0, null]] },
    isEmptyExpr('$renderStage')
  ]
};

const DIGEST_RELEASABLE = Object.freeze({
  $and: [
    isEmptyExpr('$veoPredictionId'),                 // video spend receipt
    STATIC_RECEIPT_FREE,                             // static spend receipt
    isEmptyExpr('$renderUrl'),                       // something was delivered
    NEVER_RENDERED,                                  // billed-then-crashed guard
    { $not: [startsWithTombstoneExpr] }              // no double-wrap
  ]
});

/**
 * True only for a row whose digest we actually released and can hand back.
 * A row archived before this change (or a paid row we deliberately did not
 * tombstone) has no `preArchiveIdentityDigest` and is left exactly as it is.
 */
const DIGEST_RESTORABLE = Object.freeze({
  $and: [
    { $ne: [{ $ifNull: ['$preArchiveIdentityDigest', ''] }, ''] },
    startsWithTombstoneExpr
  ]
});

/**
 * ⚠️ THE SUBMIT-IN-FLIGHT WINDOW, and why `status:'rendering'` is opt-in.
 *
 * "Receipt-free" means "we hold no receipt", NOT "it was never billed"
 * (services/spendReceipt.js says so at length). Providers charge at SUBMIT and
 * the receipt is written AFTER the POST returns, so for one HTTP round-trip a
 * genuinely-billed ad is receipt-free. `renderAttempts` does not help — it is
 * `$inc`'d when a render ENDS, not when it starts.
 *
 * ⚠️ THIS CLAUSE IS NOT THE WHOLE GUARD, and an earlier version of this comment
 * wrongly said it was ("that window is only reachable while status:'rendering'").
 * It is reachable as `queued` too, because every rendering→queued REQUEUE site
 * moves such a row out of 'rendering' without waiting for a receipt. The
 * durable guard for that is `wasRendering` in NEVER_RENDERED above; this clause
 * only covers a row archived while it is STILL rendering. Both are needed.
 *
 * While an ad is `status:'rendering'`, freeing its digest would let a later
 * Generate re-mint and re-buy a ~$0.90
 * Omni master, so the default is: a `rendering` row is archived but KEEPS its
 * digest.
 *
 * The single exception is Stop's undispatched tail. Those ids come from
 * `p.queue.slice(p.next)` — ads this loop provably never handed to a renderer,
 * so no submit exists to be in flight. That call site, and only that one,
 * passes `allowRenderingRelease: true`. Do not add a second one without the
 * same by-construction proof.
 */
const NOT_RENDERING = Object.freeze({ $ne: ['$status', 'rendering'] });

function releasableExpr(allowRenderingRelease) {
  return allowRenderingRelease
    ? DIGEST_RELEASABLE
    : { $and: [...DIGEST_RELEASABLE.$and, NOT_RENDERING] };
}

// Fields this module owns. A caller cannot smuggle them in through extraSet —
// silently letting one through would defeat the whole guard.
//
// `wasRendering` is managed for a subtle reason worth stating: passing
// `extraSet: { wasRendering: false }` would NOT change the archive's own
// decision (every expression in a `$set` stage is evaluated against the INPUT
// document), so it would look harmless — but the flag would be cleared on the
// stored row, a later restore would carry the `false`, and a SECOND archive
// would then release a BILLED identity. Throw instead.
const MANAGED_FIELDS = Object.freeze([
  'identityDigest', 'preArchiveIdentityDigest', 'status', 'updatedAt', 'wasRendering'
]);

// ── THE REQUEUE-SITE LEDGER ──────────────────────────────────────────────
// Every site that moves an Ad from 'rendering' back to 'queued' must spread
// EXACTLY ONE of these into its `$set`. Neither is optional and neither may be
// implied by omission: a site that stamps nothing is indistinguishable from a
// site whose author forgot, and that ambiguity is what the ledger removes.
//
//   REQUEUE_MARK  — "a billable submit MAY have happened behind this requeue."
//                   Stamps the durable marker, so the archive helper will never
//                   free this identity. The safe default.
//   PRE_DISPATCH  — "no submit can have happened, and control flow PROVES it."
//                   Deliberately writes nothing. Only for sites where the
//                   submit code was structurally never entered.
//
// WHY EXEMPTIONS EXIST AT ALL. Marking a provably submit-free row is not free:
// the 24h sweeper then archives it and KEEPS its digest, silently undoing the
// archive-digest release for exactly the never-billed rows that release was
// written for. Over-marking is a squatted identity; under-marking is a re-bought
// ~$0.90 Omni master. The asymmetry still governs — so exempt ONLY on proof,
// and stamp whenever it is a judgement call.
const REQUEUE_MARK = Object.freeze({ wasRendering: true });
const PRE_DISPATCH = Object.freeze({});

/**
 * The verdict for every requeue site, in ONE place so the next reader does not
 * re-derive it. scripts/verifyArchiveDigestRelease.js cross-checks this table
 * against a fresh scan AND pins each exemption's proof structurally, so a site
 * that later gains a reachable submit path fails the harness.
 */
const REQUEUE_SITES = Object.freeze([
  { file: 'routes/ads.js', site: 'generate:cas-lost-release', verdict: 'PRE_DISPATCH',
    proof: 'the running-flip CAS fails and the handler `return`s BEFORE `await runRenderLoop(...)`, '
         + 'which is where the first billable submit lives. Pinned by E15a.' },
  { file: 'routes/ads.js', site: 'generate:prep-render-crash', verdict: 'REQUEUE_MARK',
    proof: 'wraps runRenderLoop — a submit may well have happened.' },
  { file: 'routes/ads.js', site: 'claimAdsForRun:anomaly-release', verdict: 'PRE_DISPATCH',
    proof: 'inside the claim itself; claimAdsForRun contains no submit call at all. Pinned by E15b.' },
  { file: 'routes/ads.js', site: 'runs:render-loop-crash', verdict: 'REQUEUE_MARK',
    proof: 'wraps runRenderLoop — a submit may well have happened.' },
  { file: 'routes/ads.js', site: 'runs:post-claim-throw', verdict: 'PRE_DISPATCH',
    proof: 'the outer catch; `setImmediate(runRenderLoop)` is the LAST statement of the try, so no '
         + 'await follows it and the catch cannot run after the loop began. Pinned by E15c.' },
  { file: 'routes/ads.js', site: 'renderDeriveOnlyVideoAd:wait-requeue', verdict: 'PRE_DISPATCH',
    proof: 'the derive path is submit-free by contract (crop + titling only). Pinned by E15d here '
         + 'and by verifyPmaxVideoExpansion E1.' },
  { file: 'services/processAlerts.js', site: 'sigterm:orphan-persist', verdict: 'REQUEUE_MARK',
    proof: 'fires at an arbitrary point in a render; a submit may be in flight.' },
  { file: 'worker.js', site: 'reaper:stale-rendering', verdict: 'REQUEUE_MARK',
    proof: 'fires at an arbitrary point in a render; a submit may be in flight.' }
]);

// WHY THE EXEMPTIONS ARE SAFE ACROSS PASSES, not just within one. A row that
// was billed in an EARLIER pass can only reach a later claim by having been
// requeued out of 'rendering' first — and every such path is in the table
// above, so it already carries the marker (which is never cleared). The four
// PRE_DISPATCH sites therefore only ever see rows whose CURRENT pass submitted
// nothing; a billed history is already recorded. That induction is exactly as
// strong as the scan's completeness, which is why E14's self-probe matters.

// ── THE UNDISPATCHED-TAIL GAP (closed 2026-08-19) ─────────────────────────
//
// `wasRendering: true` answers "may a submit sit behind this?" — it never
// answered "did the render loop ever even LOOK at this row?", and the four
// REQUEUE_MARK sites (both crash catches in routes/ads.js, the worker.js
// reaper, and processAlerts.js's SIGTERM handler) all release a BATCH of
// claimed ads in one `updateMany`/pipeline write with no per-row distinction.
// A row the render loop's pool never reached (still sitting in
// `pool.queue.slice(pool.next)` when the run died) carries no `renderStage` —
// `adStage()` is the only writer of that field and it is called from INSIDE a
// render attempt, never at claim time — so it was released looking IDENTICAL
// to a fresh, never-claimed mint leftover: `status:'queued'`, `renderStage`
// empty. `services/strandedRunSweeper.js` requires a `renderStage` breadcrumb
// specifically to separate those two cases, so this population was invisible
// to it BY DESIGN, forever — not a mint leftover waiting for an explicit
// claim, but a genuinely claimed-and-abandoned row with no automatic path
// back except an operator noticing and pressing "Generate more" (which,
// measured across 14 real runs, was not happening: 46 of 307 claimed ads —
// 15% — sat `queued` with no `renderStage` while every run that exceeded
// `VEO_CONCURRENCY` in one wave reported itself "done" or "failed" as if
// nothing were owed).
//
// THE FIX IS NOT TO WIDEN THE SWEEPER'S FILTER. `renderStage` presence stays
// exactly what it always was: the one signal `buildStrandedAdFilter` trusts to
// mean "this was not a fresh mint leftover". Widening it to accept an empty
// stage would make the sweeper unable to tell the two populations apart ever
// again — exactly the ambiguity it exists to avoid. Instead, every
// REQUEUE_MARK site now writes an HONEST stage of its own, at the point of
// release, so the ambiguity never reaches the sweeper's query at all:
// `buildRequeueSetStage` stamps a breadcrumb describing WHY this row is back
// in `queued` — but only when `renderStage` is CURRENTLY empty (`$ifNull`).
// An ad that had already begun a render attempt (e.g. mid derive-wait,
// `adStage()` already having written "derive-only: waiting for master …")
// keeps that more specific, already-true note; only a row that was provably
// never looked at gets the generic "claimed but never dispatched" stamp.
// Either way, `queued` + empty `renderStage` becomes unreachable for a row
// that ever passed through one of these four sites, and the EXISTING sweeper
// — unmodified — picks it up on its next tick exactly as it already does for
// every other `renderStage`-carrying stranded row. No new claim path, no new
// double-bill surface: recovery still runs through `requeueStrandedAds` →
// `claimAdsForRun`, the same atomic `status:'queued'` CAS every other caller
// uses.
function buildRequeueSetStage({ breadcrumb, now = new Date() } = {}) {
  if (typeof breadcrumb !== 'string' || !breadcrumb.trim()) {
    throw new Error('adArchiveDigest: buildRequeueSetStage needs a non-empty breadcrumb string');
  }
  return {
    status:        { $literal: 'queued' },
    updatedAt:     { $literal: now },
    // Same marker every REQUEUE_MARK site has always spread — a submit may
    // sit behind this release, so the archive-digest release must never see
    // this row as provably pre-dispatch.
    wasRendering:  { $literal: true },
    // Never clobber a real, already-more-specific stage. "Empty" here is
    // deliberately the SAME test services/strandedRunSweeper.js's own filter
    // uses (`renderStage: { $nin: [null, ''] }`) — null/missing OR '' — not a
    // bare `$ifNull`, which alone only substitutes on null/missing and would
    // leave a legacy `renderStage: ''` row (still "no stage", by the
    // sweeper's own definition) un-stamped and therefore still invisible to
    // it. The CAS-lost PRE_DISPATCH release nulls renderStage on purpose and
    // does not use this builder, so it never reaches this expression at all.
    renderStage: {
      $cond: [
        { $eq: [{ $ifNull: ['$renderStage', ''] }, ''] },
        { $literal: breadcrumb },
        '$renderStage'
      ]
    },
    renderStageAt: { $ifNull: ['$renderStageAt', { $literal: now }] }
  };
}

/** Wrap the stage above as the one-stage pipeline `updateMany`/`updateOne` want. */
function buildRequeuePipeline(opts) {
  return [{ $set: buildRequeueSetStage(opts) }];
}

/**
 * Wrap caller-supplied values as aggregation LITERALS.
 *
 * ⚠️ Not cosmetic. Inside a pipeline a bare string beginning with `$` is a
 * FIELD PATH, so an operator saving `copy.headline = "$50 off"` through
 * PATCH /api/ads/:id would otherwise resolve to the (missing) field "50 off"
 * and silently blank the headline. Every extraSet value is a literal.
 */
function literalize(extraSet = {}) {
  const out = {};
  for (const [k, v] of Object.entries(extraSet || {})) {
    if (v === undefined) continue;
    if (MANAGED_FIELDS.includes(k)) {
      throw new Error(`adArchiveDigest: "${k}" is managed by this helper — do not pass it in extraSet`);
    }
    out[k] = { $literal: v };
  }
  return out;
}

/**
 * The `$set` stage that archives a row and releases its digest when — and only
 * when — DIGEST_RELEASABLE holds for that row.
 */
function buildArchiveSetStage({ extraSet = {}, now = new Date(), allowRenderingRelease = false } = {}) {
  const releasable = releasableExpr(allowRenderingRelease);
  return {
    ...literalize(extraSet),
    preArchiveIdentityDigest: {
      $cond: [releasable, '$identityDigest', '$preArchiveIdentityDigest']
    },
    identityDigest: {
      $cond: [
        releasable,
        { $concat: [TOMBSTONE_PREFIX, { $toString: '$_id' }] },
        '$identityDigest'
      ]
    },
    // ⚠️ RECORD THE RENDER HISTORY BEFORE IT IS LOST. Archiving erases the
    // fact that a row was 'rendering', and ad.restore sends a renderUrl-less
    // archived row back to 'queued' — which is CLAIMABLE and BILLABLE. Without
    // this, the chain
    //     rendering (billed, receipt not yet written)
    //       → archived (digest correctly KEPT, status forgotten)
    //       → ad.restore → queued, wasRendering false
    //       → 24h sweeper archives it → digest RELEASED → next Generate re-buys
    // reopens the very hole the marker exists to close, one step removed.
    // Stamping here is precise, not blanket: only a row whose INPUT status is
    // 'rendering' is marked, so mint leftovers (always 'queued') are untouched
    // and the digest release they exist for is unaffected.
    //
    // Omitted entirely when the caller proved pre-dispatch (Stop's undispatched
    // tail) — marking those would squat an identity nothing ever bought.
    ...(allowRenderingRelease ? {} : {
      wasRendering: {
        $cond: [{ $eq: ['$status', 'rendering'] }, true, { $ifNull: ['$wasRendering', false] }]
      }
    }),
    status:    { $literal: 'archived' },
    updatedAt: { $literal: now }
  };
}

/**
 * ⚠️ THE INVARIANT THIS ENFORCES STRUCTURALLY: a tombstone digest may NEVER sit
 * on a row whose status is anything but 'archived'.
 *
 * The digest restore is a `$cond`, so an earlier draft that set `status`
 * unconditionally had a hole: a row carrying `archived:<_id>` but with an empty
 * `preArchiveIdentityDigest` (a strict-schema drop, a hand-edited row, a
 * partially-migrated legacy state) would be flipped to queued/draft/live with
 * the TOMBSTONE still live as its identity. `selectAdsForRun` matches
 * `status:'queued'`, so that row is then claimable and BILLABLE under a fake
 * identity — and the real identity is still free for a remint, so the same
 * creative can be bought twice.
 *
 * So the status flip rides the SAME condition as the digest: a tombstoned row
 * with nothing to restore keeps `status:'archived'`. Callers detect it by the
 * status not having changed and must report a refusal, never success.
 */
const TOMBSTONE_WITHOUT_BACKUP = Object.freeze({
  $and: [
    startsWithTombstoneExpr,
    { $eq: [{ $ifNull: ['$preArchiveIdentityDigest', ''] }, ''] }
  ]
});

/** The `$set` stage that un-archives a row and hands its digest back. */
function buildRestoreSetStage({ status, extraSet = {}, now = new Date() } = {}) {
  if (typeof status !== 'string' || !status || status === 'archived') {
    throw new Error(`adArchiveDigest: restore needs a non-archived target status (got ${String(status)})`);
  }
  return {
    ...literalize(extraSet),
    identityDigest: {
      $cond: [DIGEST_RESTORABLE, '$preArchiveIdentityDigest', '$identityDigest']
    },
    preArchiveIdentityDigest: {
      $cond: [DIGEST_RESTORABLE, null, '$preArchiveIdentityDigest']
    },
    // NOT an unconditional flip — see TOMBSTONE_WITHOUT_BACKUP above.
    status: {
      $cond: [TOMBSTONE_WITHOUT_BACKUP, '$status', { $literal: status }]
    },
    updatedAt: { $literal: now }
  };
}

/**
 * Did a restore actually take? Callers pass the post-write document.
 * `false` means the row was a tombstone with no digest to hand back and was
 * deliberately left archived.
 */
function restoreTookEffect(doc, wantedStatus) {
  return !!doc && doc.status === wantedStatus;
}

/** Refusal text for the unrestorable-tombstone case. */
const UNRESTORABLE_TOMBSTONE_MESSAGE =
  'cannot restore: this ad\'s identity digest was released when it was archived and the saved ' +
  'copy is missing, so restoring it would put a placeholder identity on a live ad. Left archived.';

const buildArchivePipeline = (opts) => [{ $set: buildArchiveSetStage(opts) }];
const buildRestorePipeline = (opts) => [{ $set: buildRestoreSetStage(opts) }];

/**
 * THE archive write. Every `$set: { status: 'archived' }` on Ad goes through
 * here or through `archiveOneReleasingDigest` below.
 *
 * @param {import('mongoose').Model} model  the Ad model (injected so the
 *        harness can drive the real pipeline against a stub)
 * @param {object} filter  the caller's own filter. Inert-by-construction
 *        callers MUST also carry receiptFree() + renderUrl-empty here.
 */
function archiveAdsReleasingDigest(model, filter, opts = {}) {
  return model.updateMany(filter, buildArchivePipeline(opts));
}

/** Single-document archive that returns the updated doc (`{ new: true }`). */
function archiveOneReleasingDigest(model, filter, opts = {}) {
  const { queryOptions = { new: true }, ...rest } = opts;
  return model.findOneAndUpdate(filter, buildArchivePipeline(rest), queryOptions);
}

/** Bulk un-archive, restoring each row's released digest. */
function restoreAdsRestoringDigest(model, filter, opts = {}) {
  return model.updateMany(filter, buildRestorePipeline(opts));
}

/** Single-document un-archive that returns the updated doc. */
function restoreOneRestoringDigest(model, filter, opts = {}) {
  const { queryOptions = { new: true }, ...rest } = opts;
  return model.findOneAndUpdate(filter, buildRestorePipeline(rest), queryOptions);
}

/**
 * A restore can legitimately fail: a repeat Generate may have re-minted the
 * identity while this row sat archived (which is the whole point of releasing
 * the slot). The unique index rejects the write with 11000.
 *
 * Callers MUST surface that as a 409 and leave the ad archived. Swallowing it
 * and keeping the tombstone as a live digest would put a fake identity on a
 * claimable row.
 */
function isDigestCollisionError(err) {
  if (!err) return false;
  const code = err.code ?? err?.cause?.code ?? null;
  return Number(code) === 11000;
}

// ── THE STOP-HANDLER ARCHIVE FILTERS ─────────────────────────────────────
// Pure functions, exported, so scripts/verifyArchiveDigestRelease.js can
// evaluate the REAL query against REAL document shapes. Same reasoning as
// queuedArchiveSweeper.buildQueuedArchiveFilter: a source-text assertion
// cannot tell a working query from one that merely still contains the right
// words, and these two queries decide what an operator's Stop destroys.
//
// They live here rather than inline in routes/ads.js because runRenderLoop is
// a closure with no export seam, and because requiring routes/ads.js from a
// harness drags in half the service graph (axios, Atlas clients) — the
// MODULE_NOT_FOUND trap in CLAUDE.md §4.

/** renderUrl empty — "nothing was delivered". Default is null; '' is defensive. */
const NO_RENDER_URL = Object.freeze([{ $or: [{ renderUrl: null }, { renderUrl: '' }] }]);

/**
 * A filter that is guaranteed to match nothing. Used to fail closed.
 * Deep-frozen: callers spread it, and a shared mutable `$in` array would be a
 * fail-OPEN waiting to happen.
 */
const MATCH_NOTHING = Object.freeze({ _id: Object.freeze({ $in: Object.freeze([]) }) });

/**
 * Stop, scope 1 — the ads THIS RUN claimed (bulk-flipped to 'rendering' at
 * claim time) and never dispatched.
 *
 * renderAttempts is deliberately absent (the 24h sweeper does gate on it):
 * Stop parks its own tail whatever it has already attempted. A receipt-holding
 * or renderUrl-bearing row is refused and stays 'rendering' — honest, still
 * visible to ALERT_RENDERING_STALE_MIN, and still recoverable for free by
 * bootRecoveryService instead of being hidden in 'archived'.
 */
function buildStopUndispatchedArchiveFilter({ adIds } = {}) {
  const ids = Array.isArray(adIds) ? adIds.filter((id) => id != null && id !== '') : [];
  if (!ids.length) return { ...MATCH_NOTHING };
  return receiptFree({
    _id: { $in: ids },
    status: 'rendering',
    $and: [...NO_RENDER_URL]
  });
}

/**
 * Stop, scope 2 — THIS RUN's own minted-but-unclaimed backlog.
 *
 * ⚠️ THE FIX (2026-08-18). This used to be `{ campaignId, status: 'queued' }` —
 * every queued ad on the campaign, including rows other runs minted and are
 * legitimately waiting to claim, and mint leftovers waiting for a "Generate
 * more". Stopping run A destroyed run B's work. Owner ruled it a bug.
 *
 * OWNERSHIP IS `campaignRunIds`, and one array-membership test covers both
 * kinds of ownership: the MINTING run is stamped into campaignRunIds at insert
 * (campaignAdsGenerationService.mintedCampaignRunIds(generationRunId)) and a
 * CLAIM $addToSet's the claiming run (claimAdsForRun). There is no separately
 * persisted `generationRunId` path on Ad to test — it is a digest input and the
 * source of campaignRunIds[0], never a schema field of its own.
 *
 * FAIL CLOSED on a missing runId. `{ campaignRunIds: undefined }` is stripped
 * by the driver, which would leave `{ status: 'queued' }` — every queued ad in
 * the DATABASE, across every brand. Matching nothing is the only safe answer.
 */
function buildStopBacklogArchiveFilter({ runId } = {}) {
  if (runId == null || String(runId) === '') return { ...MATCH_NOTHING };
  return receiptFree({
    campaignRunIds: String(runId),
    status: 'queued',
    $and: [...NO_RENDER_URL]
  });
}

module.exports = {
  TOMBSTONE_PREFIX,
  DIGEST_COLLISION_MESSAGE,
  UNRESTORABLE_TOMBSTONE_MESSAGE,
  TOMBSTONE_WITHOUT_BACKUP,
  STATIC_RECEIPT_FREE,
  NEVER_RENDERED,
  restoreTookEffect,
  MANAGED_FIELDS,
  REQUEUE_MARK,
  PRE_DISPATCH,
  REQUEUE_SITES,
  buildRequeueSetStage,
  buildRequeuePipeline,
  tombstoneFor,
  isTombstoneDigest,
  DIGEST_RELEASABLE,
  DIGEST_RESTORABLE,
  buildArchiveSetStage,
  buildRestoreSetStage,
  NOT_RENDERING,
  releasableExpr,
  buildArchivePipeline,
  buildRestorePipeline,
  archiveAdsReleasingDigest,
  archiveOneReleasingDigest,
  restoreAdsRestoringDigest,
  restoreOneRestoringDigest,
  isDigestCollisionError,
  buildStopUndispatchedArchiveFilter,
  buildStopBacklogArchiveFilter,
  MATCH_NOTHING
};
