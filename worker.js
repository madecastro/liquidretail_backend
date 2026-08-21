// Background worker. Polls two queues:
//   1. DetectRun  — new Media-keyed pipeline (detect-image / detect-video).
//   2. Job        — legacy queue still used by the truck-photo inventory
//                   flow and the pre-cropped → inventory bridge. These will
//                   migrate to their own Media-keyed runs in a later refactor.
//
// DetectRun is checked first so detect work never starves behind a long
// inventory job. Both queues are FIFO by createdAt.
//
// Concurrency: WORKER_CONCURRENCY env var spawns N parallel polling
// loops in this single process. The findOneAndUpdate atomically claims
// a queued row (filter status:'queued' → set status:'processing'), so
// two loops can't double-claim. Default 2 — comfortable on Render's
// 512MB free tier where each in-flight run holds image bytes briefly.
// Bump to 4-6 on paid plans; pipeline is mostly I/O-bound so memory
// is the only real ceiling.

require('dotenv').config();
// Repo-versioned non-secret defaults — see index.js. Env always wins.
require('dotenv').config({ path: require('path').join(__dirname, 'config', 'defaults.env') });

// Crash / restart / shutdown alerting. Idempotent, so the RUN_WORKER=true
// single-process mode (where index.js requires this file) installs once.
require('./services/processAlerts').installProcessAlerts({ role: 'worker' });

const mongoose = require('mongoose');

const Job          = require('./models/Job');
const DetectRun    = require('./models/DetectRun');
const Ad           = require('./models/Ad');
const CampaignRun  = require('./models/CampaignRun');

const { processDetectRun }       = require('./pipelines/detect');
const { processPreCroppedJob }   = require('./pipelines/bridge');
const { processLegacyUploadJob } = require('./pipelines/inventory');
const { sleep }                  = require('./pipelines/shared');
const { startScheduler }         = require('./services/scheduledSyncService');

// Parallel worker loops — resolved in services/concurrency.js
// (WORKER_CONCURRENCY, hard-capped at 100).
const { concurrency: CONC, logConcurrencyConfig } = require('./services/concurrency');
const CONCURRENCY = CONC.WORKER_CONCURRENCY;
logConcurrencyConfig();

// Shared with routes/ads.js — see services/staleness.js for why these are not
// parsed inline. Must be required above the const declarations that call them.
const { reapStaleMin, prepareStaleMin } = require('./services/staleness');

// Orphan reaper tuning. STALE_MIN is the threshold past which a claimed
// (status: 'processing' / 'rendering' / 'running') doc is presumed
// abandoned — the original holder died without releasing it. Conservative
// 15 min default so legitimately slow work isn't reaped mid-flight.
// REAP_INTERVAL_MIN drives the periodic sweep alongside the startup pass.
//
// REAP_STALE_MIN is parsed by services/staleness.js, NOT inline here: the web
// process's concurrency gate keys off the same bound (routes/ads.js), and this
// file and that one used to parse it two different ways — agreeing on every
// input except a negative value, where this side resolved to 1 and handed the
// reaper a ONE-MINUTE threshold. Read it once at boot, as before, so the value
// stays fixed for the process lifetime.
const REAP_STALE_MIN     = reapStaleMin();
const REAP_INTERVAL_MIN  = Math.max(1, parseInt(process.env.REAP_INTERVAL_MIN, 10)  || 5);
// How far back a 'failed' CampaignRun is still worth re-checking against real
// Ad truth (services/campaignRunGuards.js buildRecentlyFailedFilter — read
// that header for WHY this pass exists: 'failed' is the last thing written,
// not necessarily final truth). 3h default: generous enough to catch a run
// whose "lost" ads were drained and successfully re-rendered by
// services/strandedRunSweeper.js after the original failure (that service has
// its own attempt/backoff budget, not measured in minutes here, so this stays
// wide), cheap enough that the indexed `{status:'failed', completedAt}` scan
// stays a handful of rows even on a busy day.
const FAILED_RUN_RECONCILE_WINDOW_MIN = Math.max(1, parseInt(process.env.FAILED_RUN_RECONCILE_WINDOW_MIN, 10) || 180);
// A 'preparing' CampaignRun NEVER heartbeats — no write to the row exists
// anywhere between mint (routes/ads.js POST /generate) and the flip to
// 'running' (after expandWizardJob + claim), so updatedAt === startedAt for
// the entire expansion. Unlike REAP_STALE_MIN above — safe on updatedAt
// because services/campaignRunHeartbeat.js beats a live 'running' run every
// ~60s while its render loop has work in flight — this threshold is
// unavoidably "time since mint". (Until 2026-08-18 this parenthetical credited
// the per-ad $inc with the liveness guarantee. It never had it: a $inc is a
// COMPLETION notification, and a run with 15 quiet minutes of video titling
// behind it was reaped alive. See the running sweep below.)
//
// THIS SWEEP is hygiene. THIS VAR IS NOT — corrected 2026-08-18, because the
// previous version of this comment drew the line in the wrong place and a real
// defect hid behind it for three PRs.
//
// What is true, and unchanged: the SWEEP below cannot be the thing standing
// between a slow expansion and a double bill. It runs on a 5-minute cadence
// (or never, if the worker is down), so nothing may depend on it having
// ticked. All it does is stamp a dead-looking row 'failed' for visibility.
//
// What the old comment got wrong: it concluded from that "so raising this var
// costs nothing but a longer-lived alert". PREPARE_STALE_MIN is not read only
// by this sweep. It is the PREPARING-LIFECYCLE WINDOW, and routes/ads.js reads
// the same getter for two money-facing decisions:
//
//   * buildRunningFlipFilter's age guard — how long a run may still win its
//     own 'preparing'→'running' CAS;
//   * the 'preparing' arm of buildActiveRunsFilter — how long that run still
//     blocks an identical duplicate request at the concurrency gate.
//
// Those two must stay equal (services/campaignRunGuards.js module header has
// the inequality and why the other direction double-bills), so this value is
// load-bearing in both directions, not free to raise.
//
// WHY IT IS NOW 30 AND WAS WRONG AT 15. The arithmetic the old comment already
// contained is the argument: the Director round alone can burn up to 2 paid
// attempts x (TIMEOUT_MS=120s + retries with backoff) = ~12 min
// (services/atlasLlmService.js MAX_ATTEMPTS/BACKOFF_MS/TIMEOUT_MS,
// services/aiCreativeDirectorService.js "worst case stays TWO"), plus the Judge
// call on top — **~18-20 min is a realistic healthy ceiling, not a crash**. The
// flip guard was keyed on REAP_STALE_MIN (15), i.e. BELOW that ceiling. So an
// expansion finishing at T=18 min lost its own CAS: the ads it had just claimed
// were released back to 'queued', the run was stamped 'failed', and the
// operator was shown a crash that never happened. The old comment said this var
// was "hygiene only" and therefore safe at 15 — but the 15 that mattered was
// the flip's, and it was the same documented default, so the contradiction with
// the ceiling written two paragraphs above never got noticed.
//
// 30 clears the ~18-20 min ceiling with headroom. Separate name from
// REAP_STALE_MIN so RUNNING runs and Ads keep the 15-minute claimed-doc window
// on updatedAt — raising THAT would delay orphan requeue for every claimed doc,
// a different and unwanted trade. This knob cannot reach those sweeps, so
// nothing holding claimed work waits longer than before; what waits longer is a
// wedged EXPANSION, which holds no claimed ads and no recoverable spend (see
// the sweep's own comment below). Same parser (services/staleness.js), so a
// nonsense value falls back to the documented default instead of clamping to 1.
//
// NOTE the clock difference, because it is easy to conflate the two windows:
// this one is MINT AGE (startedAt — a preparing run never writes to its row),
// while REAP_STALE_MIN is SILENCE (updatedAt, refreshed by the ~60s beat in
// services/campaignRunHeartbeat.js as well as by every per-ad $inc — the $inc
// alone was NOT a liveness signal and reaped a live run on 2026-08-18).
// The gate's two arms mirror exactly that split; keying its running arm on mint
// age instead was a confirmed double-bill P0 (2026-08-18) — see
// services/campaignRunGuards.js buildActiveRunsFilter.
const PREPARE_STALE_MIN  = prepareStaleMin();

// Health sweep → Slack (services/backlogWatchdog.js). Separate cadence
// from the reaper so the thresholds can be tuned independently.
const WATCHDOG_INTERVAL_MIN = Math.max(1, parseInt(process.env.ALERT_WATCHDOG_INTERVAL_MIN, 10) || 5);

const alerts = require('./services/alertService');
// Receipt guard for every rendering->queued requeue — see services/spendReceipt.js.
const { receiptFree, HAS_RECEIPT } = require('./services/spendReceipt');
// Requeue pipeline — the reaper fires at an arbitrary point in a render, so a
// billable submit may be in flight behind it (REQUEUE_MARK's `wasRendering:
// true`, never PRE_DISPATCH — see the REQUEUE_SITES ledger in
// services/adArchiveDigest.js). buildRequeuePipeline stamps that marker AND
// an honest renderStage breadcrumb on a row that never got dispatched — see
// its header comment ("THE UNDISPATCHED-TAIL GAP") for why that is required
// here specifically: this reap fires on a claimed ad the render loop's pool
// never even reached, which carries no renderStage, and
// services/strandedRunSweeper.js can never pick up a `queued` row with an
// empty one.
const { buildRequeuePipeline } = require('./services/adArchiveDigest');
const {
  buildStalePreparingFilter,
  buildStaleRunningFilter,
  classifyRunAdOutcome,
  buildRunReconciliationUpdate,
  buildRecentlyFailedFilter
} = require('./services/campaignRunGuards');
// Pure Slack-message builder for the preparing-reap notice below — see
// services/slackRunVerbosity.js header (no Mongo/network at require-time).
const { buildPreparingReapNotice } = require('./services/slackRunVerbosity');

// Mongoose default pool is 100 max. With 50+ concurrent workers each
// firing several queries per pipeline stage, we want a roomy pool to
// avoid head-of-line blocking. Cap at 200 to stay well under typical
// Atlas tier limits (M0 free = 500, M10 = 1500).
const MONGO_POOL_SIZE = Math.max(50, Math.min(CONCURRENCY * 3, 200));

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser:    true,
  useUnifiedTopology: true,
  maxPoolSize:        MONGO_POOL_SIZE
}).then(async () => {
  console.log(`🔌 Connected to MongoDB (pool=${MONGO_POOL_SIZE}); starting ${CONCURRENCY} worker loop(s)`);

  // Index sync. Mongoose's default autoIndex builds indexes lazily on
  // first model use, which races against the worker loop's first
  // DetectRun.create — partial unique indexes (the in-flight uniqueness
  // guard on DetectRun(mediaId), the one on Ad(campaignId, identityDigest))
  // would not exist yet, so duplicate-creation races slip through. After
  // a DB drop this is the only way to ensure the partial uniques are in
  // place before the worker starts inserting. Awaiting it blocks startup
  // by a couple seconds at most on these small collections.
  try {
    const LayoutInputArtifact = require('./models/LayoutInputArtifact');
    const Media               = require('./models/Media');
    await Promise.all([
      DetectRun.syncIndexes(),
      Ad.syncIndexes(),
      CampaignRun.syncIndexes(),
      LayoutInputArtifact.syncIndexes(),
      // Drops the legacy global unique on (source, externalId) and
      // builds the brand-scoped (brandId, source, externalId) one.
      Media.syncIndexes()
    ]);
    console.log('✅ critical indexes synced (DetectRun, Ad, CampaignRun, LayoutInputArtifact, Media)');
  } catch (err) {
    console.warn(`⚠️  syncIndexes failed (non-fatal): ${err.message}`);
  }

  // Orphan reaper — catches DetectRun / Ad / CampaignRun docs left in
  // their "claimed" states (processing / rendering / running) when the
  // holder process died without releasing them. Runs once at boot
  // (catches crashes since last restart) and on a timer (catches
  // mid-run crashes of the web service while this worker stays alive).
  // BOOT RECOVERY RUNS BEFORE THE REAPER, deliberately. An ad holding a spend
  // receipt should become `draft` with its recovered master, not sit in
  // `rendering` waiting to be noticed. The reaper no longer requeues those ads
  // (services/spendReceipt.js), so this is about collecting the asset promptly
  // rather than about avoiding a race — but ordering keeps the two legible:
  // recovery resolves what it can, the reaper handles what is genuinely orphaned.
  //
  // Awaited at boot so the log reads in causal order, and .catch()'d because a
  // recovery failure must never stop the queues from starting. It is also on the
  // reap interval: 'processing' ads need re-checking until they terminate.
  const { resumeInFlightAds } = require('./services/bootRecoveryService');
  const recoverTick = () => resumeInFlightAds()
    .catch(err => console.warn(`⚠️  boot recovery failed: ${err.message}`));
  await recoverTick();

  await reapOrphans().catch(err => console.warn(`⚠️  initial reap failed: ${err.message}`));
  setInterval(() => {
    recoverTick();
    reapOrphans().catch(err => console.warn(`⚠️  periodic reap failed: ${err.message}`));
  }, REAP_INTERVAL_MIN * 60 * 1000);

  // Health sweep — wedged renders, stalled runs, detect backlog, spend.
  // Never awaited at boot: a slow first sweep must not delay the queues.
  // First sweep after 90s (post-boot-reap, post-Mongo-connect) so a
  // crash-looping deploy surfaces wedged state quickly instead of waiting
  // out the first full interval.
  // Singleton lease across worker instances. When the WORKER service
  // scales horizontally (Render min>1) every instance boots this file
  // and, before this lease, every instance also fired its own
  // startScheduler() + runWatchdog() timers. That doubles paid Apify
  // demo syncs (via credential.lastCatalogSyncAt races) and Slack
  // alerts. The lease pins scheduler+watchdog to a single elected
  // instance; other instances just run the DetectRun/Job loops.
  //
  // A single lease covers BOTH scheduler and watchdog — they are
  // low-frequency housekeeping and there's no reason to run them on
  // different instances. If a leader dies mid-heartbeat, the lease
  // expires after ttlMs (90s default) and another worker takes over.
  const { createSingletonLease } = require('./services/singletonLease');
  const housekeepingLease = createSingletonLease('worker-housekeeping', {
    ttlMs: 90_000,
    heartbeatMs: 30_000
  });
  const isLeader = await housekeepingLease.acquire();
  if (isLeader) housekeepingLease.startHeartbeat();
  console.log(`🎫 housekeeping lease: ${isLeader ? 'ACQUIRED' : 'held by another instance'} (id=${housekeepingLease.INSTANCE_ID})`);

  const { runWatchdog } = require('./services/backlogWatchdog');
  const watchdogTick = () => {
    if (!housekeepingLease.holds()) return;
    return runWatchdog().catch(err => console.warn(`⚠️  watchdog failed: ${err.message}`));
  };
  setTimeout(watchdogTick, 90 * 1000);
  setInterval(watchdogTick, WATCHDOG_INTERVAL_MIN * 60 * 1000);

  // Non-leaders re-check every 60s in case the leader died and we can take over.
  if (!isLeader) {
    setInterval(async () => {
      if (housekeepingLease.holds()) return;
      const took = await housekeepingLease.acquire();
      if (took) {
        housekeepingLease.startHeartbeat();
        console.log('🎫 housekeeping lease: acquired after leader change — starting scheduler + watchdog');
        startScheduler();
      }
    }, 60_000);
  }

  // QUEUED-LEFTOVER ARCHIVE — park mint leftovers so a later Generate cannot
  // claim and bill them. WORKER, not web: this sweep never renders (no
  // Remotion, no runRenderLoop, no Atlas submit). strandedRunSweeper lives
  // on web because its requeue half needs the render loop; this is the
  // opposite job. Worker stays up across web deploys, which is when leftover
  // inventory is most likely sitting unclaimed. Never throw — same contract
  // as the watchdog above.
  const { sweepQueuedLeftovers, ENABLED: ARCHIVE_ENABLED } = require('./services/queuedArchiveSweeper');
  if (!ARCHIVE_ENABLED()) {
    console.log('🗃️  queued archive: disabled (QUEUED_ARCHIVE_ENABLED=false)');
  } else {
    const archiveIntervalMin = Math.max(1, parseInt(process.env.QUEUED_ARCHIVE_INTERVAL_MIN, 10) || 15);
    const archiveTick = () => sweepQueuedLeftovers()
      .catch(err => console.warn(`⚠️  queued archive failed: ${err.message}`));
    setTimeout(archiveTick, 90 * 1000);
    setInterval(archiveTick, archiveIntervalMin * 60 * 1000);
    console.log(`🗃️  queued archive: every ${archiveIntervalMin}m (after ${process.env.QUEUED_ARCHIVE_AFTER_H || 24}h, max ${process.env.QUEUED_ARCHIVE_MAX_ADS || 200}/pass)`);
  }
  // Name the vars the code ACTUALLY reads. This line said "Telegram … set
  // TELEGRAM_BOT_TOKEN" for the whole of the Slack cutover, so the one place
  // an operator looks to find out why alerts are silent told them to set two
  // variables nothing reads any more.
  console.log(`🔔 alerts: ${alerts.isConfigured() ? 'Slack configured' : 'Slack NOT configured (set SLACK_BOT_TOKEN in Render env; SLACK_ALERT_CHANNEL ships in config/defaults.env)'}; watchdog every ${WATCHDOG_INTERVAL_MIN}m`);

  for (let i = 1; i <= CONCURRENCY; i++) {
    workerLoop(i).catch(err => console.error(`❌ worker[${i}] crashed:`, err));
  }
  // Scheduled IG sync — independent timer so it doesn't compete with
  // the queue loop for cycles. Catalog daily, posts hourly per Brand
  // settings; cap-aware DetectRun enqueueing.
  //
  // Gated on the housekeeping lease so exactly one worker instance runs
  // it. The non-leader re-check loop above will call startScheduler()
  // if a leader change happens later.
  if (isLeader) startScheduler();
}).catch(err => console.error('MongoDB error:', err));

// Sweep for orphaned in-flight docs. Cheap (3 indexed updateMany calls);
// safe to run frequently. Logs only when something was reaped so a
// healthy system doesn't fill logs with no-ops.
async function reapOrphans() {
  // ONE `now` for the whole sweep, so the inline Ad/DetectRun cutoffs and the
  // shared buildStaleRunningFilter below cannot drift by the sweep's own
  // runtime.
  const reapNow = Date.now();
  const cutoff = new Date(reapNow - REAP_STALE_MIN * 60 * 1000);

  // DetectRun: stuck in 'processing' → reset to 'queued' so the next
  // worker loop iteration claims it. The original holder is presumed
  // dead. errorStage stamped so the rerun is auditable.
  const detects = await DetectRun.updateMany(
    { status: 'processing', startedAt: { $lt: cutoff } },
    { $set: { status: 'queued', errorStage: 'orphan-reset' } }
  );

  // Ad: stuck in 'rendering' → back to 'queued'. The failed run's
  // CampaignRun stays as audit; the Ad just re-enters the queue.
  //
  // `campaignRunIds` is deliberately left intact — it is the audit trail of
  // which runs attempted this ad, and selectAdsForRun filters only on
  // (campaignId, status) so a stale entry never blocks re-selection. This
  // used to also `$set: { campaignRunId: null }`, a singular field that does
  // not exist on the schema; with the default `strict: true` mongoose
  // silently stripped it, so the write was always a no-op. Removed rather
  // than "fixed" — there is nothing that needs clearing.
  // RECEIPT-AWARE, and this split is the whole point (2026-08-04).
  //
  // This used to be ONE updateMany over every stale `rendering` ad. An ad that
  // holds a spend receipt — Ad.veoPredictionId for video, or
  // imageGeneration.predictionId for static — has ALREADY been billed: the
  // provider accepted the job and charged for it at submit. Sending that ad
  // back to `queued` means the next run SUBMITS IT AGAIN, so we pay a second
  // time for a generation Atlas may have already delivered. That is exactly the
  // hole atlasVideoService's own comment describes: "without it a crash mid-poll
  // loses the only handle to work we have paid for, and the reaper re-queues the
  // ad into a second submit."
  //
  // So only RECEIPT-FREE ads are requeued. Those were never billed — the
  // process died before or during submit — so re-running them costs one charge,
  // which is the charge that was always owed.
  //
  // Receipt-holding ads are deliberately LEFT IN `rendering`. That looks
  // untidy and it is the correct trade: `rendering` is honest (the outcome
  // genuinely is unknown until the receipt is polled), the ad stays visible to
  // ALERT_RENDERING_STALE_MIN, and the receipt survives for a resume pass to
  // recover the asset for free. Requeuing would replace an untidy state with a
  // duplicate charge. Never trade money for tidiness here.
  //
  // buildRequeuePipeline (not a bare `$set`) is what closes the undispatched-
  // tail gap (adArchiveDigest.js, "THE UNDISPATCHED-TAIL GAP"). This reap
  // fires at an arbitrary point in a render — sometimes on a row the pool had
  // already dispatched (which already carries a real `renderStage` from
  // `adStage()`, and the `$ifNull` inside the pipeline leaves it alone), and
  // sometimes on a row the render loop's pool never even reached before the
  // process holding it died (which carries none). Both are stamped
  // `wasRendering: true` exactly as the old REQUEUE_MARK spread did; the only
  // change is that the second case no longer leaves `renderStage` empty, so
  // it stops being permanently invisible to strandedRunSweeper's breadcrumb
  // requirement.
  const ads = await Ad.updateMany(
    receiptFree({ status: 'rendering', updatedAt: { $lt: cutoff } }),
    buildRequeuePipeline({ breadcrumb: 'reaped: claimed but never dispatched — run stalled for over ' + REAP_STALE_MIN + 'm' })
  );

  // Count what we deliberately did NOT requeue, so "why is this ad still
  // rendering?" has an answer in the log instead of looking like a reaper bug.
  const heldForReceipt = await Ad.countDocuments({
    status: 'rendering', updatedAt: { $lt: cutoff }, ...HAS_RECEIPT
  }).catch(() => 0);
  if (heldForReceipt > 0) {
    console.warn(
      `   💰 reaper: ${heldForReceipt} stale rendering ad(s) hold a spend receipt — NOT requeued ` +
      `(requeuing would re-submit work already paid for). Poll the receipt to recover.`
    );
  }

  // CampaignRun: stuck 'running' → reconcile from real Ad truth (see the
  // reconciliation block below, after the ⚠️ history this predicate carries)
  // so the frontend poller resolves to an HONEST terminal state — 'done' if
  // every claimed Ad already settled, 'failed' with completedAt only if some
  // were genuinely lost. The individual Ads inside the run were handled by
  // the Ad sweep above.
  //
  // Staleness is judged on updatedAt, NOT startedAt. Filtering on startedAt
  // would fail ANY run older than 15 minutes, and a serialized 20-ad video
  // batch legitimately runs 25-35 — the healthy long batch would be marked
  // failed while still rendering.
  //
  // ⚠️ THIS SWEEP FALSELY KILLED A LIVE RUN IN PRODUCTION (2026-08-18,
  // run_1787105727540_e8c94542) and the comment that used to sit here is why
  // nobody caught it: it asserted "a live run heartbeats roughly once a
  // minute" on the strength of the per-ad `$inc { succeeded/failed }`. That is
  // not a heartbeat, it is a COMPLETION notification — it fires when an ad
  // SETTLES, so a run with 18 statics done and 21 video rows serialising
  // behind titling wrote nothing for 15 minutes and was stamped 'failed' with
  // `errors: []`, `failed: 0`, while it was still rendering. 9 of its ads were
  // stranded 'queued' by the Ad sweep above on the identical silence.
  //
  // services/campaignRunHeartbeat.js now beats the row every ~60s for as long
  // as the render loop reports real in-flight work (and stops the instant it
  // does not, so a wedged run is still reaped). That is what makes the
  // predicate below mean "the holder died" rather than "nothing settled
  // lately". Filter extracted to campaignRunGuards so the harness can evaluate
  // the real one.
  // The write used to be `{ $set: { status: 'failed', completedAt: new Date() } }`
  // and nothing else — no errors[] entry, so a reaped run read exactly like
  // the header above describes: "Nothing threw. It was still rendering." with
  // zero explanation on the run poller itself. `buildStaleRunningReapUpdate`
  // (services/campaignRunGuards.js) now pushes a real errors[] row naming the
  // stale window — GET /api/ads/runs/:id can say why instead of a bare status
  // flip. It is called from INSIDE `buildRunReconciliationUpdate` below, not
  // directly here — see that function's header in campaignRunGuards.js for
  // why a blind write must never itself guess at succeeded/failed/skipped.
  //
  // RECONCILE FROM AD TRUTH FIRST — do not blindly stamp 'failed'.
  //
  // A stale `updatedAt` on the CampaignRun row means "the process holding
  // this run's runRenderLoop went quiet", NOT "the work did not happen".
  // Two other paths — titlingResumeService, bootRecoveryService — can drive
  // an Ad all the way to its terminal `draft`+renderUrl shape without ever
  // touching this CampaignRun (no counter $inc, no heartbeat, no `done`
  // write: that write lives ONLY at the end of runRenderLoop's own
  // in-memory Promise.all, routes/ads.js). So a run whose original process
  // died can have every one of its claimed Ads already delivered by the time
  // this sweep looks at it — measured in production, run_1787263897396_ef1fcb32:
  // 9/9 Ads drafted with a real renderUrl, CampaignRun left 'running' until
  // the operator gave up and cancelled what looked like a permanent spinner.
  //
  // The reverse gap is the same class: blindly stamping 'failed' here with
  // no counter update is what produced the sibling shape (status:'failed',
  // succeeded:18 stale) while all 39 Ads already carried a renderUrl — the
  // run object disagreeing with reality in the OTHER direction.
  //
  // So: find() the stale candidates, then decide EACH one from its real
  // claimed Ads (services/campaignRunGuards.js classifyRunAdOutcome) —
  //   · a receipt-holding Ad still 'rendering' (deliberately NOT requeued by
  //     the Ad-sweep above, so it can finish for free) means real, paid-for
  //     work is still outstanding — leave status:'running' untouched; the
  //     next tick (REAP_INTERVAL_MIN later) re-checks. Often this is a run
  //     simply waiting behind a sibling run's share of the global
  //     VEO_CONCURRENCY/REMOTION_QUEUE_CONCURRENCY pools, not stalled.
  //   · every claimed Ad settled, none lost → the run genuinely finished;
  //     write 'done' with the REAL succeeded/failed counts.
  //   · every claimed Ad settled, some reset to 'queued' by the Ad-sweep
  //     above → genuinely abandoned work; write 'failed' (same reaper
  //     explanation as before) but with real counts instead of stale zeros.
  //
  // One find() + per-row updateOne() rather than one blind updateMany():
  // each candidate needs its own Ad-truth read before it can be judged. The
  // candidate set is small by construction (buildActiveRunsFilter's own
  // header: "in practice 0-2 rows" per campaign) and this sweep runs on a
  // background cadence (REAP_INTERVAL_MIN), never on a request path.
  const staleRunCandidates = await CampaignRun.find(
    buildStaleRunningFilter({ now: reapNow, staleMin: REAP_STALE_MIN })
  ).select('_id runId').lean();

  let nRunsFailed = 0, nRunsReconciled = 0, nRunsDeferred = 0, nRunsDeferredTitling = 0;
  for (const candidate of staleRunCandidates) {
    // classifyRunAdOutcome's video-titling check (services/adTitlingTruth.js)
    // needs kind/renderUrl/veoVideoUrl/titlingResumeState/renderStage in
    // addition to status — a `status`-only projection silently defeats that
    // check (an unselected `kind` reads as `undefined !== 'video'`, so every
    // Ad would be treated as a static and the titling debt would never be
    // seen at all).
    const claimedAds = await Ad.find({ campaignRunIds: candidate.runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
      .lean();
    const outcome = classifyRunAdOutcome(claimedAds);
    if (!outcome.isSettled) {
      nRunsDeferred++;
      if (outcome.titlingIncomplete > 0) nRunsDeferredTitling++;
      continue;
    }
    const update = buildRunReconciliationUpdate(outcome, { staleMin: REAP_STALE_MIN, now: new Date(reapNow) });
    // Re-checks status:'running' at write time — the same CAS discipline as
    // buildRunningFlipFilter/buildTerminalDoneFilter elsewhere in this
    // module: this run's own loop (or an earlier tick) may have already
    // resolved it between the find() above and this write.
    const res = await CampaignRun.updateOne({ _id: candidate._id, status: 'running' }, update)
      .catch(() => ({ modifiedCount: 0 }));
    if (!(res.modifiedCount ?? res.nModified ?? 0)) continue;
    if (outcome.needsRetry) nRunsFailed++; else nRunsReconciled++;
  }
  if (nRunsReconciled > 0) {
    console.log(
      `✅ reconciled ${nRunsReconciled} CampaignRun(running) → done from real Ad truth ` +
      `(every claimed ad had already settled; the process that owned the render loop ` +
      `never got to write its own done stamp)`
    );
  }
  if (nRunsDeferred > 0) {
    console.log(
      `⏳ left ${nRunsDeferred} stale-looking CampaignRun(running) alone — ` +
      `receipt-holding ad(s) still genuinely rendering or untitled-master ` +
      `recovery in flight (${nRunsDeferredTitling} of them for titling), not abandoned`
    );
  }

  // ── HEAL RECENTLY-'failed' RUNS TOO (2026-08-20 incident) ────────────────
  // See services/campaignRunGuards.js buildRecentlyFailedFilter's header for
  // the full why. Short version: `status:'failed'` is not necessarily FINAL
  // truth — at least three writers (this reaper's OWN former blind stamp,
  // processAlerts.js persistOrphans on SIGTERM, routes/ads.js's crash
  // handlers) can land a run there without ever looking at its Ads, and a
  // run this reaper reconciled correctly a tick ago can still go stale again
  // if services/strandedRunSweeper.js later drains its "lost" (queued) ads
  // into a successful re-render — that service fixes the Ad, never the
  // CampaignRun row it came from. Re-run the SAME classify/reconcile pass
  // against recent 'failed' rows so all of these self-heal on this reaper's
  // existing cadence, instead of needing a bespoke fix at every writer
  // (including ones not discovered yet). Measured incident shape this closes:
  // two runs (brian@egami.tv, 2026-08-20) stuck at `status:'failed',
  // succeeded:18, total:39` while every one of the 39 claimed Ads was
  // genuinely `draft` with a real renderUrl.
  const recentlyFailedCandidates = await CampaignRun.find(
    buildRecentlyFailedFilter({ now: reapNow, windowMin: FAILED_RUN_RECONCILE_WINDOW_MIN })
  ).select('_id runId succeeded failed status').lean();

  let nRunsHealed = 0;
  for (const failedCandidate of recentlyFailedCandidates) {
    // Wide projection, matching the running-run pass above (PR #278):
    // classifyRunAdOutcome's video-titling check needs kind/renderUrl/
    // veoVideoUrl/titlingResumeState/renderStage too — a status-only
    // projection would silently misjudge every video Ad.
    const claimedAds = await Ad.find({ campaignRunIds: failedCandidate.runId })
      .select('status kind renderUrl veoVideoUrl titlingResumeState renderStage')
      .lean();
    if (claimedAds.length === 0) continue; // nothing claimed — nothing to reconcile
    const outcome = classifyRunAdOutcome(claimedAds);
    // Same guard fix as services/processAlerts.js persistOrphans (adversarial
    // review, 2026-08-20): defer ONLY when nothing has been lost AND
    // something is still genuinely outstanding (`!isSettled` — receipt-
    // holding + rendering, OR, since PR #278, an untitled paid master). A
    // bare `!outcome.isSettled` would also defer a candidate that already
    // HAS a lost (`needsRetry`) Ad — but this candidate is already
    // `status:'failed'`, so there is no gate/sweeper visibility to protect
    // here the way there is in persistOrphans; the reason to still wait is
    // purely to avoid computing a premature (undercounted) succeeded/failed
    // while an outstanding sibling's outcome is still genuinely unknown.
    if (!outcome.isSettled && !outcome.needsRetry) continue;
    const healed = buildRunReconciliationUpdate(outcome, { staleMin: REAP_STALE_MIN, now: new Date(reapNow) });
    const alreadyCorrect = healed.$set.status === failedCandidate.status &&
      healed.$set.succeeded === failedCandidate.succeeded &&
      healed.$set.failed === failedCandidate.failed;
    if (alreadyCorrect) continue; // stored counters already match Ad truth — do not touch completedAt or spam a write
    const res = await CampaignRun.updateOne({ _id: failedCandidate._id, status: 'failed' }, healed)
      .catch(() => ({ modifiedCount: 0 }));
    if (res.modifiedCount ?? res.nModified ?? 0) nRunsHealed++;
  }
  if (nRunsHealed > 0) {
    console.log(
      `🩹 healed ${nRunsHealed} previously-'failed' CampaignRun(s) whose stored succeeded/failed ` +
      `counters had drifted from real Ad truth (e.g. work delivered by titlingResumeService / ` +
      `bootRecoveryService / strandedRunSweeper after the original failure was stamped)`
    );
  }

  const runs = { modifiedCount: nRunsFailed };

  // CampaignRun stuck in 'preparing' → mark 'failed'. Distinct from the sweep
  // above: this covers a run that died BEFORE it ever reached 'running' — the
  // one AUTO-REMEDIATION gap nothing else in this codebase closes.
  // `expandWizardJob` (Director + Judge, then the atomic Ad claim) makes zero
  // writes to the CampaignRun row, so a web instance replaced mid-expansion
  // (deploy, autoscale, or crash) leaves the row exactly as minted:
  // status:'preparing', total:0, updatedAt frozen at startedAt — forever,
  // since nothing else RESOLVES this (backlogWatchdog.js already ALERTS on
  // stale 'preparing' rows — buildStalledRunFilter's status $in explicitly
  // includes it — but alerting is not remediation; the SIGTERM handler's
  // in-flight registry isn't populated until AFTER this same flip, so
  // persistOrphans sees zero in-flight work and never touches it either).
  //
  // Money-safe, but NOT because of this sweep — see buildRunningFlipFilter's
  // comment (services/campaignRunGuards.js) for the actual guard, which is
  // independent of whether this has run at all. What this sweep does is
  // purely visibility/hygiene: stamp a dead-looking row 'failed' so it stops
  // showing up as a silent no-op. (The VALUE it uses is money-facing even
  // though this sweep is not — PREPARE_STALE_MIN is shared with the flip guard
  // and the gate's preparing arm. See its declaration above.) Any Ad claimed before the running-flip is
  // receipt-free by construction — no veoPredictionId, no
  // imageGeneration.predictionId — so the existing receipt-aware Ad sweep
  // above already releases those back to 'queued' regardless of this sweep's
  // timing. What IS already spent (Director/Judge LLM cost) is not
  // recoverable by a reaper and this sweep does not try.
  // Captured BEFORE the updateMany, same `now` snapshot passed to BOTH
  // calls (below) so the two filters are byte-identical — no race between
  // "which rows did we read" and "which rows did we flip" — so the
  // dedicated Slack notice below can name which runs these were.
  // updateMany's modifiedCount alone cannot say run id / campaign / age.
  // Bounded (.limit) because this is a rare hygiene event, not a hot path.
  const stalePreparingNow = Date.now();
  const stalePrepsDocs = await CampaignRun.find(
    buildStalePreparingFilter({ now: stalePreparingNow, staleMin: PREPARE_STALE_MIN })
  )
    .select('runId campaignId startedAt')
    .limit(20)
    .lean()
    .catch(() => []);
  const preps = await CampaignRun.updateMany(
    buildStalePreparingFilter({ now: stalePreparingNow, staleMin: PREPARE_STALE_MIN }),
    {
      $set: { status: 'failed', completedAt: new Date() },
      $push: { errors: {
        index: 0, stage: 'expand',
        // Observation only, not a diagnosis: at this threshold the far more
        // likely cause is the Director/Judge retry ladder simply taking
        // longer than expected (see PREPARE_STALE_MIN's comment above for
        // the real worst-case math), not an instance replacement. Do not
        // assert a cause an operator would go hunting deploy logs for.
        message: `expansion never completed — no CampaignRun write in ${PREPARE_STALE_MIN}m after mint`
      } }
    }
  );

  const nDetects = detects.modifiedCount || 0;
  const nAds     = ads.modifiedCount     || 0;
  const nRuns    = runs.modifiedCount    || 0;
  const nPreps   = preps.modifiedCount   || 0;
  const total = nDetects + nAds + nRuns + nPreps;
  if (total > 0) {
    console.log(
      `🧹 reaped: ${nDetects} DetectRun · ${nAds} Ad · ${nRuns} CampaignRun(running) · ` +
      `${nPreps} CampaignRun(preparing) (stale > ${REAP_STALE_MIN}m / ${PREPARE_STALE_MIN}m)`
    );

    // THE "work got dropped" alert. Reaping an Ad or a CampaignRun means a
    // process died holding claimed work — a deploy, an autoscale scale-in,
    // or a crash. The reset ads go back to 'queued', and nothing drains
    // 'queued' automatically (selectAdsForRun is only reachable from
    // POST /api/ads/generate and POST /api/ads/runs), so somebody has to
    // press "Generate more" or that work never resumes. Reaping only
    // DetectRuns is benign — the worker re-claims those itself — so that
    // case stays at warn. A 'preparing' reap holds no claimed Ads (see the
    // comment above the sweep) so it is a lost EXPANSION, not lost render
    // work — counted into `dropped` anyway because the outcome an operator
    // cares about is the same: this Generate produced nothing and needs a
    // manual re-run.
    const dropped = nAds + nRuns + nPreps;
    alerts.notifyAsync({
      level: dropped > 0 ? 'error' : 'warn',
      title: dropped > 0
        ? `Dropped work reclaimed — ${nAds} ad(s), ${nRuns + nPreps} run(s)`
        : `Reclaimed ${nDetects} stale detect run(s)`,
      key: 'reaper:reaped',
      fields: {
        'ads reset to queued': nAds || undefined,
        'runs marked failed':  nRuns || undefined,
        'runs failed (never started rendering)': nPreps || undefined,
        'detect runs requeued': nDetects || undefined,
        'stale threshold':     `${REAP_STALE_MIN}m running / ${PREPARE_STALE_MIN}m preparing`,
        ...(nAds > 0 ? { 'action needed': 'ads sit in queued until someone re-runs the campaign' } : {})
      }
    });
  }

  // Dedicated preparing-reap notice — the aggregate alert above only counts
  // 'runs failed (never started rendering)'; it names no run, no campaign,
  // no age, and no drain path, so an operator seeing only a count has no way
  // to act on it. Every run named here holds NO claimed ads (expansion never
  // reached the claim step — see the sweep's own comment above), so the
  // minted ads (if any) are intact and sitting 'queued', not lost.
  // Independent of `total` above (own try/catch) so a lookup failure here
  // can never suppress the aggregate alert or take down the reaper.
  if (stalePrepsDocs.length) {
    try {
      const nowMs = Date.now();
      const runsDetail = await Promise.all(stalePrepsDocs.map(async (r) => {
        const drainableCount = await Ad.countDocuments({
          campaignRunIds: r.runId,
          status: 'queued'
        }).catch(() => 0);
        const ageMin = Math.round((nowMs - new Date(r.startedAt).getTime()) / 60000);
        return {
          runId: r.runId,
          campaignId: r.campaignId ? String(r.campaignId) : null,
          ageMin,
          drainableCount
        };
      }));
      const notice = buildPreparingReapNotice({ runs: runsDetail, staleMin: PREPARE_STALE_MIN });
      alerts.notifyAsync({
        level: 'warn',
        title: notice.title,
        key: 'reaper:preparing-reap',
        fields: notice.fields,
        detail: notice.detail
      });
    } catch (err) {
      console.warn(`⚠️  preparing-reap notice failed (non-fatal): ${err.message}`);
    }
  }

  // OperationRun (unified progress rows): stale-heartbeat runs from
  // dead processes → failed, so the ActivityDock never shows a ghost
  // "running" forever. Never fatal to the reaper.
  await require('./services/progressService').sweepStaleRuns().catch(() => {});
}

async function workerLoop(workerId) {
  const tag = `[W${workerId}]`;
  while (true) {
    // ── New world: DetectRun (Media-keyed) ──
    let run = null;
    try {
      run = await DetectRun.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing', startedAt: new Date() },
        // Lower priority drains first. Catalog-product runs default to
        // 1; IG-post runs are stamped with 2 by postSyncService so the
        // product visual index is built before media-path matches.
        // FIFO within a priority band via createdAt.
        { new: true, sort: { priority: 1, createdAt: 1 } }
      );
    } catch (err) {
      console.error(`❌ ${tag} DetectRun poll failed:`, err.message);
    }
    if (run) {
      console.log(`🧩 ${tag} Processing DetectRun ${run._id} (media=${run.mediaId})`);
      try {
        await processDetectRun(run);
      } catch (err) {
        console.error(`❌ ${tag} DetectRun failed:`, err.message || err);
        run.status     = 'failed';
        run.error      = err.message || String(err);
        run.errorStage = err.stage || 'unknown';
        run.completedAt = new Date();
        try { await run.save(); } catch (e) { console.error(`${tag} Failed to persist run failure:`, e.message); }
      }
      continue;
    }

    // ── Legacy: Job (truck-photo upload + pre-cropped bridge) ──
    let job = null;
    try {
      job = await Job.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing' },
        { new: true }
      );
    } catch (err) {
      console.error(`❌ ${tag} Job poll failed:`, err.message);
    }
    if (job) {
      console.log(`🧩 ${tag} Processing Job ${job._id} (${job.fileType || 'image'}) [legacy]`);
      try {
        if (job.fileType === 'pre-cropped') await processPreCroppedJob(job);
        else                                await processLegacyUploadJob(job);
      } catch (err) {
        console.error(`❌ ${tag} Job failed:`, err.message || err);
        job.status     = 'failed';
        job.error      = err.message || 'Unknown error';
        job.errorStage = err.stage || 'unknown';
        try { await job.save(); } catch (e) { console.error(`${tag} Failed to persist job failure:`, e.message); }
      }
      continue;
    }

    // Both empty. Stagger sleeps slightly across workers so they don't
    // all wake at the same instant and dogpile the next-arriving run.
    await sleep(2500 + Math.floor(Math.random() * 1000));
  }
}
