// Helpers used by both the Inventory and Detect pipelines.
// Anything pipeline-specific goes in the pipeline's own file, not here.

const axios = require('axios');

async function downloadBuffer(url, label) {
  try {
    const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 120000 });
    return Buffer.from(res.data);
  } catch (err) {
    const e = new Error(`Failed to download ${label}: ${err.message}`);
    e.stage = label;
    throw e;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stage-timing helpers (Detect pipeline uses these to populate result.stageTimings,
// which the UI's ⏱ Timings drawer renders. Keep them here so the dispatcher can
// finalize any in-flight stage after a pipeline throws.)
async function setStage(job, stage) {
  finalizeStage(job);
  job._stageCurrent = stage;
  job._stageStartedAt = Date.now();
  job.detectionStage = stage;
  await job.save();
  console.log(`   → ${stage}`);
}

function finalizeStage(job) {
  if (job._stageCurrent && job._stageStartedAt) {
    const elapsed = Date.now() - job._stageStartedAt;
    job._stageTimings = job._stageTimings || {};
    job._stageTimings[job._stageCurrent] = (job._stageTimings[job._stageCurrent] || 0) + elapsed;
  }
}

module.exports = { downloadBuffer, sleep, setStage, finalizeStage };
