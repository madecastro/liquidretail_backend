// Background worker — polls MongoDB for queued jobs and dispatches each to the
// correct pipeline handler. Keep this file small; all per-pipeline logic lives
// under pipelines/.
//
// Job fileType → handler map:
//   detect-image, detect-video   → pipelines/detect.js     (social-media analysis)
//   pre-cropped                  → pipelines/bridge.js     (approved crops → inventory)
//   image, video, (default)      → pipelines/inventory.js  (truck photo → Shopify)

require('dotenv').config();
const mongoose = require('mongoose');
const Job = require('./models/Job');

const { processDetectJob } = require('./pipelines/detect');
const { processPreCroppedJob } = require('./pipelines/bridge');
const { processLegacyUploadJob } = require('./pipelines/inventory');
const { sleep } = require('./pipelines/shared');

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('🔌 Connected to MongoDB');
  processJobsLoop();
}).catch(err => console.error('MongoDB error:', err));

async function processJobsLoop() {
  while (true) {
    let job = null;
    try {
      job = await Job.findOneAndUpdate(
        { status: 'queued' },
        { status: 'processing' },
        { new: true }
      );
      if (!job) { await sleep(3000); continue; }

      console.log(`🧩 Processing job ${job._id} (${job.fileType || 'image'})`);

      if (job.fileType === 'detect-image' || job.fileType === 'detect-video') {
        await processDetectJob(job);
      } else if (job.fileType === 'pre-cropped') {
        await processPreCroppedJob(job);
      } else {
        await processLegacyUploadJob(job);
      }
    } catch (err) {
      console.error('❌ Job failed:', err.message || err);
      if (job) {
        job.status = 'failed';
        job.error = err.message || 'Unknown error';
        job.errorStage = err.stage || 'unknown';
        await job.save();
      }
    }
  }
}
