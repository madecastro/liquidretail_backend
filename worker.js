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

const CONCURRENCY = Math.max(1, Math.min(parseInt(process.env.WORKER_CONCURRENCY, 10) || 2, 100));

// Orphan reaper tuning. STALE_MIN is the threshold past which a claimed
// (status: 'processing' / 'rendering' / 'running') doc is presumed
// abandoned — the original holder died without releasing it. Conservative
// 15 min default so legitimately slow work isn't reaped mid-flight.
// REAP_INTERVAL_MIN drives the periodic sweep alongside the startup pass.
const REAP_STALE_MIN     = Math.max(1, parseInt(process.env.REAP_STALE_MIN, 10)     || 15);
const REAP_INTERVAL_MIN  = Math.max(1, parseInt(process.env.REAP_INTERVAL_MIN, 10)  || 5);

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
    await Promise.all([
      DetectRun.syncIndexes(),
      Ad.syncIndexes(),
      CampaignRun.syncIndexes(),
      LayoutInputArtifact.syncIndexes()
    ]);
    console.log('✅ critical indexes synced (DetectRun, Ad, CampaignRun, LayoutInputArtifact)');
  } catch (err) {
    console.warn(`⚠️  syncIndexes failed (non-fatal): ${err.message}`);
  }

  // Orphan reaper — catches DetectRun / Ad / CampaignRun docs left in
  // their "claimed" states (processing / rendering / running) when the
  // holder process died without releasing them. Runs once at boot
  // (catches crashes since last restart) and on a timer (catches
  // mid-run crashes of the web service while this worker stays alive).
  await reapOrphans().catch(err => console.warn(`⚠️  initial reap failed: ${err.message}`));
  setInterval(() => {
    reapOrphans().catch(err => console.warn(`⚠️  periodic reap failed: ${err.message}`));
  }, REAP_INTERVAL_MIN * 60 * 1000);

  for (let i = 1; i <= CONCURRENCY; i++) {
    workerLoop(i).catch(err => console.error(`❌ worker[${i}] crashed:`, err));
  }
  // Scheduled IG sync — independent timer so it doesn't compete with
  // the queue loop for cycles. Catalog daily, posts hourly per Brand
  // settings; cap-aware DetectRun enqueueing.
  startScheduler();
}).catch(err => console.error('MongoDB error:', err));

// Sweep for orphaned in-flight docs. Cheap (3 indexed updateMany calls);
// safe to run frequently. Logs only when something was reaped so a
// healthy system doesn't fill logs with no-ops.
async function reapOrphans() {
  const cutoff = new Date(Date.now() - REAP_STALE_MIN * 60 * 1000);

  // DetectRun: stuck in 'processing' → reset to 'queued' so the next
  // worker loop iteration claims it. The original holder is presumed
  // dead. errorStage stamped so the rerun is auditable.
  const detects = await DetectRun.updateMany(
    { status: 'processing', startedAt: { $lt: cutoff } },
    { $set: { status: 'queued', errorStage: 'orphan-reset' } }
  );

  // Ad: stuck in 'rendering' → back to 'queued' and clear campaignRunId
  // so the next selectAdsForRun pass re-picks it on a fresh run. The
  // failed run's CampaignRun stays as audit; the Ad just re-enters the queue.
  const ads = await Ad.updateMany(
    { status: 'rendering', updatedAt: { $lt: cutoff } },
    { $set: { status: 'queued', campaignRunId: null, updatedAt: new Date() } }
  );

  // CampaignRun: stuck 'running' → mark 'failed' with completedAt so
  // the frontend poller resolves. The individual Ads inside the run
  // were handled by the Ad sweep above.
  const runs = await CampaignRun.updateMany(
    { status: 'running', startedAt: { $lt: cutoff } },
    { $set: { status: 'failed', completedAt: new Date() } }
  );

  const total = (detects.modifiedCount || 0) + (ads.modifiedCount || 0) + (runs.modifiedCount || 0);
  if (total > 0) {
    console.log(
      `🧹 reaped: ${detects.modifiedCount || 0} DetectRun · ` +
      `${ads.modifiedCount || 0} Ad · ${runs.modifiedCount || 0} CampaignRun ` +
      `(stale > ${REAP_STALE_MIN}m)`
    );
  }
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
