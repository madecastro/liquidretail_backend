// CampaignRun — tracks one click of the Generate Ads button.
//
// POST /api/ads/generate creates a CampaignRun, returns its runId
// immediately (202), then renders creatives in the background. The
// frontend polls GET /api/ads/runs/:id to watch progress and knows
// the batch is finished when status flips from 'running' to 'done'.
//
// runId is the same string we stamp onto Ad.campaignRunId so the ads
// page can join { Ads with that runId } ↔ { the run's status counts }.
//
// Failure mode: if the server restarts mid-run, ads that finished
// remain persisted but the run will hang in 'running'. The frontend
// times out the poller after a generous ceiling (currently 5 min,
// adjustable in Ads page).

const mongoose = require('mongoose');

const campaignRunSchema = new mongoose.Schema({
  runId:        { type: String, required: true, unique: true, index: true },

  brandId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',    required: true, index: true },
  campaignId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  campaignKind: { type: String, default: null },

  // The productIds this run was ASKED for, stamped at mint time (before the
  // background expansion runs, which is the whole point — the concurrency gate
  // in POST /generate has to make its decision while this run is still
  // 'preparing' and `perProduct` is necessarily empty).
  //
  // Still stamped, but since 2026-08-10 it is NO LONGER what the concurrency
  // gate decides on — see requestFingerprint below. It remains the product scope
  // of record for reporting, for the rollout-compat comparison in
  // services/generationGate.js, and for the non-blocking "another run shares
  // these products" notice. An empty array is now a legitimate value (a
  // media-library run seeds from media, not a SKU) and no longer blocks anything.
  requestedProductIds: { type: [String], default: [] },

  // WHAT THE CONCURRENCY GATE ACTUALLY COMPARES. A stable hash over the fields
  // of POST /api/ads/generate that determine what gets generated
  // (services/generationGate.js computeRequestFingerprint). Stamped at mint time
  // because the gate has to decide while this run is still 'preparing'.
  //
  // Load-bearing for money: an identical fingerprint on an in-flight run is the
  // double-click, and it is the only thing now refused by default. Note the
  // failure direction is fail-OPEN — a run with no fingerprint cannot be proven
  // identical to anything, so it will not block a sibling. That is deliberate
  // (blocking on an unknown is what stopped the media library from generating at
  // all), which is exactly why this write must never be dropped: losing it
  // silently disables double-click protection instead of over-blocking.
  requestFingerprint: { type: String, default: null, index: true },

  // UGC-ads Phase 3 — operator-picked UGCs the run was seeded with. Populated
  // by /api/ads/generate when preferUgcMediaId is present. adRegenerateService
  // reads this so regenerate re-applies the same UGC at ref 1 — without
  // persistence the regen path can only replay Ad.mediaIds, which points at
  // the wizard's UGC but does not distinguish "operator-picked seed" from
  // "director-picked supporting media" for the catalog-first reseed rule
  // (§ REGEN_RESEED_CATALOG_FIRST). Array (not scalar) because Phase 7's
  // batch wizard will dispatch one CampaignRun with multiple UGCs, one per
  // expanded product.
  seedUgcIds:          { type: [String], default: [] },

  total:        { type: Number, default: 0 },
  // Ads THIS run minted (expandWizardJob newlyQueued). Distinct from `total`,
  // which stays the CLAIM count — that is the progress-bar denominator
  // (succeeded+failed+skipped / total). If we stuffed minted into `total`, a
  // 34-mint / 20-claim run would hang the bar at 20/34 forever, because the
  // leftovers are not in this run and will never increment those counters.
  // The operator still needs to see the gap: GET /runs returns both fields,
  // and `notice` names the unclaimed count when it is > 0.
  mintedTotal:      { type: Number, default: 0 },
  unclaimedAtStart: { type: Number, default: 0 },
  // Non-blocking notice, SAME SHAPE as the 202's `notice`
  // ({ code, message, ... }). Overlap is written at mint (known then);
  // the unclaimed-overflow notice overwrites it after claim (the 202
  // already delivered overlap; the poller is where post-expand facts land,
  // same as perProduct / total).
  notice: { type: mongoose.Schema.Types.Mixed, default: null },
  succeeded:    { type: Number, default: 0 },
  skipped:      { type: Number, default: 0 },
  failed:       { type: Number, default: 0 },

  // 'preparing' = expandWizardJob is running in the background (Director +
  // Judge LLM calls). Was previously sync on the request path, but Render's
  // edge can cut a ~28s request even when the backend is healthy — moved
  // off-request so /api/ads/generate responds 202 immediately.
  status:       { type: String, enum: ['preparing', 'running', 'done', 'failed'], default: 'preparing', index: true },

  errors: [{
    _id:        false,
    index:      Number,
    stage:      String,
    template:   String,
    aspectRatio: String,
    mediaId:    String,
    productId:  String,
    message:    String,
    // ── LLM failure taxonomy (services/llmError.js) — AND, since 2026-08-19,
    // the image/video equivalent (services/atlasErrorPolicy.js's IMAGE_*
    // codes, e.g. IMAGE_MODERATION_BLOCKED). Both taxonomies write into the
    // SAME plain-String fields below — they are unconstrained (no Mongoose
    // enum), and the two are already namespace-disjoint (LLM_* vs IMAGE_*),
    // so one render-failure row and one LLM-failure row never collide on
    // meaning. A direct-image render failure's `stage` is always 'render'
    // (or 'upload'/'crash'), never a Director/LLM stage, so a reader can
    // still tell which taxonomy produced a given code without a lookup.
    //
    // DECLARED, not free-form: this schema is STRICT, so an undeclared path is
    // silently DROPPED on write — the trap that already lost
    // `renderError.predictionId` (CLAUDE.md §2/§4). Adding the field to the
    // write site without adding it here would look correct, pass every
    // source-text harness, and store nothing.
    //
    // `code`   — stable UPPER_SNAKE class (LLM_RATE_LIMITED, LLM_TIMEOUT, …
    //            or IMAGE_MODERATION_BLOCKED, IMAGE_RATE_LIMITED, …).
    //            Exists because "Atlas 400: bad request" reached the operator
    //            with no way to tell a param bug from a capacity outage.
    // `action` — what the system ACTUALLY did next (EXHAUSTED_CHAIN,
    //            GAVE_UP_PRODUCT, …), so a reader can tell "we recovered"
    //            from "your ads are gone" without a log dig.
    // `chain`  — the compact ordered attempt summary, e.g.
    //            "tried a (429, 51.0s) → b (429, 50.0s) → c (ok, 1.0s)".
    //            Image/video failures leave this null — there is no
    //            multi-link fallback chain on that path, only the seed
    //            fallback recorded on `seedFallbacks` below.
    code:       String,
    action:     String,
    chain:      String
  }],

  // Cross-creative coordination for the moderation seed-fallback mitigation
  // (services/moderationSeedFallback.js, added 2026-08-19 for the incident
  // where one flagged catalog photo failed 18/18 statics for a product).
  // Best-effort only — a read/write failure here just costs one more wasted
  // primary-seed attempt on a later creative for the same product, exactly
  // the pre-fallback behaviour; nothing downstream requires this array to be
  // complete, race-free, or even present.
  seedFallbacks: [{
    _id:             false,
    productId:       String,
    // The seed this run started with for this product (CatalogProduct's
    // merchant-feed-order default, or the Ad's Director-picked media) —
    // recorded so an operator can see WHAT was swapped away from, per the
    // "never silently downgrade quality" requirement.
    originalMediaId: String,
    // The first alternate catalog image this run proved clears moderation
    // for this product, if any. A creative that starts AFTER this is written
    // reads it and skips straight to it, never re-paying to rediscover it.
    resolvedMediaId: String,
    // Every catalog image id this run has proven moderation-blocked for this
    // product, so a later creative never retries a candidate already known
    // bad. Deliberately NOT deduped-on-write (a rare concurrent double-append
    // is harmless); readers dedupe.
    blocked:         [String],
    at:              Date
  }],

  // Per-product expansion outcomes. Written when expandWizardJob finishes
  // (success, empty, or partial). The poller (GET /runs/:runId) returns
  // this so the UI can tell "no imagery" from "Director returned nothing"
  // instead of the generic expand error that used to discard the real
  // reason. Shape owned by services/perProductReasons.js — keep fields
  // in sync with normalizePerProductEntry.
  perProduct: [{
    _id:               false,
    productId:         String,
    productName:       String,
    reason:            String,   // machine code, null when the product queued
    message:           String,   // human sentence for this row
    skipped:           Boolean,
    payloads:          Number,
    // Non-skip advisory (e.g. video operator stack has no catalog image).
    // MUST stay separate from `reason` — reason implies skipped:true.
    // Shape owned by services/perProductReasons.js WARNING enum.
    warning:           String,
    // Director round-contract reasons (validateDirectorPayload) — the SAME
    // reasons.slice(0,6) array the 'director:contract-warn' Slack alert
    // already sends (services/aiCreativeDirectorService.js
    // directConceptsRound). Also non-skip advisory, but kept as its OWN
    // field rather than overloaded onto `warning` above: `warning` is a
    // small fixed enum (services/perProductReasons.js WARNING) with a
    // static human sentence per code, while this is a variable-length list
    // of free-text validation reasons describing the ROUND, not this
    // product's catalog picks. Undeclared here would be silently dropped on
    // $set — same trap as renderError.predictionId (CLAUDE.md §2/§4). See
    // docs/ALERTING.md "In-app run status vs Slack" gap table.
    directorContractWarnings: { type: [String], default: undefined },
    mediaId:           String,
    mediaIds:          [String],
    conceptCount:      Number,
    conceptSkips: [{
      _id:       false,
      conceptId: String,
      reason:    String,
      mediaId:   String
    }],
    capped: [{
      _id:     false,
      kind:    String,
      format:  String,
      before:  Number,
      after:   Number,
      dropped: Number
    }],
    payloadsBeforeCap: Number,
    error:             String,
    errorName:         String,
    // Same taxonomy as errors[].code above, on the per-product row the UI
    // poller returns. Declared for the same strict-schema reason.
    errorCode:         String,
    errorAction:       String,
    errorChain:        String
  }],

  requestedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Marks a run as machine-triggered rather than a real person clicking
  // Generate — scripts/mintTestToken.js (the ui-smoke skill's offline
  // test-token minter) mints a REAL User's JWT (a genuine
  // AdvertiserMembership is required to drive the app), so `requestedBy`
  // alone cannot tell a test run from the owner's own click. Stamped at
  // mint time (routes/ads.js's CampaignRun.create call sites) from
  // `req.user.automated` / `req.user.sessionLabel`, themselves read off
  // JWT claims by middleware/requireAuth.js — never inferred here from
  // heuristics (user-agent, IP, timing, …). `isAutomated` WINS over
  // `requestedBy`'s human identity in the Slack run feed (runFeed /
  // routes/ads.js `runRenderLoop`), never merely supplements it: showing
  // both a real name AND "automated" would still read as a real person to
  // a channel skimmer. `sessionLabel` is honest-degrade, not fabricated —
  // null means "automated (Claude session)" with no name suffix, never a guessed name.
  automation: {
    isAutomated:  { type: Boolean, default: false },
    sessionLabel: { type: String,  default: null }
  },

  // Per-run Slack live feed (services/runFeedService.js). Parent message
  // ts is claimed atomically across web instances (min 1 / max 3) so two
  // processes working the same run do not each create a parent. Only the
  // winner of the conditional updateOne writes this; losers re-read and
  // thread under the winner's ts. See claimParentTs.
  slackFeed: {
    ts:      { type: String, default: null },
    channel: { type: String, default: null }
  },

  startedAt:    { type: Date, default: Date.now },
  completedAt:  { type: Date, default: null },

  // LIVENESS HEARTBEAT (services/campaignRunHeartbeat.js), written every ~60s
  // while runRenderLoop reports real in-flight work — and NOT written when it
  // does not, so a wedged run is still reaped.
  //
  // DECLARED, not optional. This schema is STRICT: an undeclared path is
  // silently DROPPED on write, which is how `renderError.predictionId` was
  // lost (CLAUDE.md §2/§4). A dropped write here would look correct in code,
  // pass every source-text check, and store nothing.
  //
  // WHY A SECOND FIELD when the beat's real job is bumping `updatedAt`:
  // `updatedAt` is now written by two different things with two different
  // meanings — an ad SETTLING (the per-ad `$inc {succeeded|failed|skipped}`,
  // refreshed by timestamps:true) and the run merely being ALIVE. Conflating
  // them is exactly what hid the 2026-08-18 incident: the reaper's
  // `updatedAt < now - REAP_STALE_MIN` predicate was read as "this run is
  // dead" when it only ever meant "no ad settled recently", and
  // run_1787105727540_e8c94542 was stamped 'failed' mid-render with
  // `errors: []`.
  //
  // READ IT LIKE THIS — and note the earlier version of this comment had the
  // reading BACKWARDS (adversarial review, same day). A beat writes BOTH
  // fields at one instant, so on a beating run they are always ~equal; only a
  // settlement moves `updatedAt` alone. The gap between them therefore means
  // "a settlement landed after the last beat", not "alive but nothing
  // settled".
  //   · `lastHeartbeatAt` fresh          → the render loop is alive and has
  //                                        work in flight (the beat is gated
  //                                        on the pools' inflight count).
  //   · stale/null while `running`       → nothing in flight, or the process
  //                                        is gone; the reaper is right to act.
  //   · is work SETTLING?                → succeeded+failed+skipped vs `total`,
  //                                        never a date gap.
  //
  // Never written alone-with-counters: the heartbeat writes THIS and
  // `updatedAt` and nothing else — never `total` (the claim count and the
  // progress denominator) and never the outcome counters.
  lastHeartbeatAt: { type: Date, default: null }
}, {
  timestamps: true,
  // `errors` is a Mongoose reserved pathname (Document.prototype has an
  // .errors property). Runtime works; this just silences the boot log
  // warning.
  suppressReservedKeysWarning: true
});

campaignRunSchema.index({ brandId: 1, createdAt: -1 });
// The /generate concurrency gate runs this exact shape twice per request
// (pre-check, then mint-then-verify): campaignId + in-flight status + the stale
// window. Separate campaignId/status indexes make it a scan over the campaign's
// whole run history, and this query sits in front of every generation.
campaignRunSchema.index({ campaignId: 1, status: 1, createdAt: -1 });
// The "you already ran this exact request" lookup: newest FINISHED run on this
// campaign with a given fingerprint, inside DUPLICATE_LOOKBACK_MIN. Without this
// the duplicate check scans the campaign's whole run history on every generate.
campaignRunSchema.index({ campaignId: 1, requestFingerprint: 1, createdAt: -1 });

module.exports = mongoose.model('CampaignRun', campaignRunSchema);
