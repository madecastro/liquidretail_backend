// Background worker. Polls two queues:
//   1. DetectRun  — new Media-keyed pipeline (detect-image / detect-video).
//   2. Job        — legacy queue still used by the truck-photo inventory
//                   flow and the pre-cropped → inventory bridge. These will
//                   migrate to their own Media-keyed runs in a later refactor.
//
// DetectRun is checked first so detect work never starves behind a long
// inventory job. Both queues are FIFO by createdAt.

require('dotenv').config();
const mongoose = require('mongoose');

const Job       = require('./models/Job');
const DetectRun = require('./models/DetectRun');

const { processDetectRun }       = require('./pipelines/detect');
const { processPreCroppedJob }   = require('./pipelines/bridge');
const { processLegacyUploadJob } = require('./pipelines/inventory');
const { sleep }                  = require('./pipelines/shared');

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('🔌 Connected to MongoDB');
  processQueueLoop();
}).catch(err => console.error('MongoDB error:', err));

async function processQueueLoop() {
  while (true) {
    // ── New world: DetectRun (Media-keyed) ──
    let run = null;
    try {
      run = await DetectRun.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing', startedAt: new Date() },
        { new: true, sort: { createdAt: 1 } }
      );
    } catch (err) {
      console.error('❌ DetectRun poll failed:', err.message);
    }
    if (run) {
      console.log(`🧩 Processing DetectRun ${run._id} (media=${run.mediaId})`);
      try {
        await processDetectRun(run);
      } catch (err) {
        console.error('❌ DetectRun failed:', err.message || err);
        run.status     = 'failed';
        run.error      = err.message || String(err);
        run.errorStage = err.stage || 'unknown';
        run.completedAt = new Date();
        try { await run.save(); } catch (e) { console.error('Failed to persist run failure:', e.message); }
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
      console.error('❌ Job poll failed:', err.message);
    }
    if (job) {
      console.log(`🧩 Processing Job ${job._id} (${job.fileType || 'image'}) [legacy]`);
      try {
        if (job.fileType === 'pre-cropped') await processPreCroppedJob(job);
        else                                await processLegacyUploadJob(job);
      } catch (err) {
        console.error('❌ Job failed:', err.message || err);
        job.status     = 'failed';
        job.error      = err.message || 'Unknown error';
        job.errorStage = err.stage || 'unknown';
        try { await job.save(); } catch (e) { console.error('Failed to persist job failure:', e.message); }
      }
      continue;
    }

    // Both empty.
    await sleep(3000);
  }
}
