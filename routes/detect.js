const express = require('express');
const multer = require('multer');
const router = express.Router();

const Media     = require('../models/Media');
const DetectRun = require('../models/DetectRun');
const DetectionArtifact   = require('../models/DetectionArtifact');
const CropArtifact        = require('../models/CropArtifact');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact  = require('../models/OverlayZoneArtifact');

// Legacy Job model — used only by the pre-cropped → inventory bridge path.
const Job = require('../models/Job');

const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const geminiImg = require('../services/geminiImageService');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }
});

// POST /api/detect
// Manual upload entry point. Creates (or upserts) a Media doc, then enqueues
// a DetectRun. Returns { runId, mediaId } — the frontend keeps polling
// /status/:runId to get the assembled result.
//
// Future webhook ingestion endpoints (Meta / TikTok / IG) will create the
// Media with their platform-supplied externalId and follow the same
// "DetectRun.create then return runId" pattern.
router.post('/', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File required' });

  const isVideo = (req.file.mimetype || '').startsWith('video/');
  const sizeMB = (req.file.size / 1024 / 1024).toFixed(1);
  console.log(`📥 /api/detect ${isVideo ? 'VIDEO' : 'IMAGE'} ${req.file.originalname} (${sizeMB}MB)`);

  let metadata = {};
  try { metadata = JSON.parse(req.body.metadata || '{}'); } catch {}

  try {
    const uploaded = await uploadBufferToCloudinary(req.file.buffer, {
      resourceType: isVideo ? 'video' : 'image'
    });

    // Manual upload → synthetic externalId so the (source, externalId) unique
    // index still applies. Webhooks will pass the real platform id.
    const externalId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const media = await Media.create({
      externalId,
      source:       'manual_upload',
      sourceUrl:    null,
      fileType:     isVideo ? 'video' : 'image',
      fileUrl:      uploaded.secure_url,
      fileMimeType: req.file.mimetype,
      fileName:     req.file.originalname,
      metadata
    });

    const run = await DetectRun.create({
      mediaId: media._id,
      status:  'queued',
      stage:   'queued',
      trigger: 'upload'
    });

    console.log(`🆕 Media ${media._id} + DetectRun ${run._id} queued`);
    // Return BOTH ids. `runId` is what status polling uses; `mediaId` is the
    // canonical handle a downstream service would use to fetch artifacts.
    // `jobId` alias kept for short-term frontend compatibility.
    res.status(202).json({ runId: run._id, mediaId: media._id, jobId: run._id });
  } catch (err) {
    console.error('Upload/queue error:', err);
    res.status(500).json({ error: 'Failed to queue detection run', message: err.message });
  }
});

// GET /api/detect/status/:runId
// Polled by the frontend. Assembles the per-stage artifacts into the unified
// `result` shape the existing UI expects (subjects / products / crops / judge
// / extendedCrops / productMatches / overlayZones / transcript). Internal
// storage is normalized; this endpoint denormalizes for caller convenience.
router.get('/status/:runId', async (req, res) => {
  try {
    const run = await DetectRun.findById(req.params.runId);
    if (!run) return res.status(404).json({ error: 'DetectRun not found' });

    let result = null;
    if (run.status === 'completed' || run.status === 'failed') {
      result = await assembleResult(run);
    }

    res.json({
      runId:      run._id,
      jobId:      run._id,            // alias for short-term frontend compat
      mediaId:    run.mediaId,
      status:     run.status,
      stage:      run.stage,
      result,
      error:      run.status === 'failed' ? run.error : null,
      errorStage: run.status === 'failed' ? run.errorStage : null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status', message: err.message });
  }
});

// Assemble the unified result the frontend renders. Pulls the run's
// associated Media doc + each per-stage artifact and flattens them into the
// shape the existing UI code reads. New artifact-aware UIs can fetch
// individual collections directly.
async function assembleResult(run) {
  const media = await Media.findById(run.mediaId);
  if (!media) return null;

  const [detection, crops, extended, match, overlayZones] = await Promise.all([
    DetectionArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    CropArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    ExtendedCropArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    ProductMatchArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    OverlayZoneArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean()
  ]);

  const stageTimings = run.stageTimings && typeof run.stageTimings.toObject === 'function'
    ? run.stageTimings.toObject()
    : (run.stageTimings || {});

  return {
    type:       media.fileType,
    imageUrl:   detection?.imageUrl || media.fileUrl,
    videoUrl:   detection?.videoUrl || (media.fileType === 'video' ? media.fileUrl : undefined),
    width:      detection?.width  || media.width  || 0,
    height:     detection?.height || media.height || 0,

    heroFrameSec:     detection?.heroFrameSec     ?? null,
    heroReason:       detection?.heroReason       || null,
    videoDurationSec: detection?.videoDurationSec ?? null,

    products:   detection?.yoloProducts || [],
    subjects:   detection?.subjects     || [],
    text:       detection?.text         || [],
    background: detection?.background   || null,
    safeRect:   detection?.safeRect     || null,
    primarySubjectDesc: detection?.primarySubjectDesc || null,

    crops:      crops?.smartCrops || {},
    judge:      crops?.judge      || null,

    extendedCrops:  extended?.candidates || {},
    extendedErrors: extended?.errors     || {},
    extendedJudge:  extended?.judge      || {},

    productMatches: match
      ? {
          query:        match.query,
          providers:    match.providers || {},
          errors:       match.errors    || {},
          totalMatches: match.totalMatches || 0,
          identification: match.identification || null
        }
      : null,

    overlayZones: overlayZones?.zones || {},

    transcript: detection?.transcript || null,
    stageTimings
  };
}

// POST /api/detect/process
// Accept approved detections, queue a pre-cropped JOB for the legacy
// inventory bridge. (This still uses the Job model — it will migrate to a
// Run-style entity when the inventory pipeline gets the same treatment.)
router.post('/process', express.json(), async (req, res) => {
  try {
    const { imageUrl, approvedBoxes, metadata } = req.body;
    if (!approvedBoxes?.length) {
      return res.status(400).json({ error: 'No approved boxes provided' });
    }
    const job = new Job({
      fileType: 'pre-cropped',
      status: 'queued',
      metadata,
      detectionData: { imageUrl, approvedBoxes }
    });
    await job.save();
    console.log(`🆕 Pre-cropped job queued: ${job._id} (${approvedBoxes.length} crops)`);
    res.status(202).json({ jobId: job._id });
  } catch (err) {
    console.error('Process error:', err);
    res.status(500).json({ error: 'Failed to queue job', message: err.message });
  }
});

// Diagnostic: GET /api/detect/gemini-models
router.get('/gemini-models', async (req, res) => {
  try {
    if (!geminiImg.isEnabled()) return res.json({ enabled: false, reason: 'GEMINI_API_KEY not set' });
    const models = await geminiImg.discoverModels();
    res.json({ enabled: true, imageCapable: models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
