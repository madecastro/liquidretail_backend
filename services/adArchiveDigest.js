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

// NEVER ENTERED A RENDER. Two independent markers, both fail-closed, because
// "receipt-free" alone cannot see a render that was billed and then CRASHED
// before the receipt was persisted (services/spendReceipt.js's irreducible
// window). Such a row is requeued to 'queued' by the reaper and can be
// re-claimed, so it reaches the archive sites looking pristine.
//   renderAttempts — $inc'd when a render ENDS. >0 ⇒ a render finished or
//                    failed here before; not a pristine identity.
//   renderStage    — written by services/adStage.js as a render PROGRESSES
//                    (and left at its final value afterwards). claimAdsForRun
//                    does NOT write it, so it is null on a claimed-but-never-
//                    dispatched row and on every mint leftover — the whole
//                    population this release exists for — and non-null on
//                    anything that ever entered a render, including the
//                    crash-before-receipt case renderAttempts misses.
// Neither is load-bearing for correctness of the archive itself; both only
// narrow WHEN a digest may be freed. Over-refusing costs a squatted slot;
// under-refusing costs a re-billed Omni master.
const NEVER_RENDERED = {
  $and: [
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
 * That window is only reachable while an ad is `status:'rendering'`. Freeing
 * such a row's digest would let a later Generate re-mint and re-buy a ~$0.90
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
const MANAGED_FIELDS = Object.freeze(['identityDigest', 'preArchiveIdentityDigest', 'status', 'updatedAt']);

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
