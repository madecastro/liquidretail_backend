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
const CatalogProduct       = require('../models/CatalogProduct');
const Category             = require('../models/Category');

// Legacy Job model — used only by the pre-cropped → inventory bridge path.
const Job = require('../models/Job');

const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const geminiImg = require('../services/geminiImageService');
const { setCuratedAsset } = require('../services/brandCatalogService');
const { hydrateMatch } = require('../services/productMatchHydration');
const { assertMediaInTenant, assertRunInTenant, tenantFilter } = require('../middleware/tenantHelpers');

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
router.post('/', upload.fields([
  { name: 'photo',     maxCount: 1 },
  { name: 'brandLogo', maxCount: 1 }
]), async (req, res) => {
  const photoFile = req.files?.photo?.[0];
  const logoFile  = req.files?.brandLogo?.[0];
  if (!photoFile) return res.status(400).json({ error: 'File required' });

  const isVideo = (photoFile.mimetype || '').startsWith('video/');
  const sizeMB = (photoFile.size / 1024 / 1024).toFixed(1);
  console.log(`📥 /api/detect ${isVideo ? 'VIDEO' : 'IMAGE'} ${photoFile.originalname} (${sizeMB}MB)${logoFile ? ` + brand logo ${logoFile.originalname}` : ''}`);

  let metadata = {};
  try { metadata = JSON.parse(req.body.metadata || '{}'); } catch {}

  try {
    const uploaded = await uploadBufferToCloudinary(photoFile.buffer, {
      resourceType: isVideo ? 'video' : 'image'
    });

    // Manual upload → synthetic externalId so the (source, externalId) unique
    // index still applies. Webhooks will pass the real platform id.
    const externalId = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // Active brand context — comes from the X-Brand-Id header
    // (set by the nav brand-picker on every API call) or an
    // explicit brandId field on the upload form. Nullable so
    // legacy callers without a brand context still work.
    const brandId = req.headers['x-brand-id'] || req.body?.brandId || null;

    const media = await Media.create({
      advertiserId: req.advertiserId,
      brandId:      brandId || null,
      externalId,
      source:       'manual_upload',
      sourceUrl:    null,
      fileType:     isVideo ? 'video' : 'image',
      fileUrl:      uploaded.secure_url,
      fileMimeType: photoFile.mimetype,
      fileName:     photoFile.originalname,
      metadata,
      // Phase 0a — provenance classification. Manual uploads have no
      // platform context; downstream services (template selector,
      // layoutInputService) treat manual_upload as "no UGC available".
      classification: { socialPostType: 'manual_upload' }
    });

    // ── Curated brand logo (optional) ──
    // If the user attached a logo file in the form, upload it and write
    // the URL onto the Brand catalog as a curated asset (protected from
    // future enrichment overwrite). Brand identity hints the user
    // typed (brand name + brand URL) live in metadata.brand and
    // metadata.brandUrl already, so we have everything needed to
    // identify which Brand row to attach to.
    if (logoFile) {
      try {
        const logoUploaded = await uploadBufferToCloudinary(logoFile.buffer, {
          resourceType: 'image',
          folder: 'brand_logos'
        });
        const brandName = (metadata.brand || '').trim();
        if (brandName) {
          await setCuratedAsset({
            name:       brandName,
            fieldName:  'logoUrl',
            value:      logoUploaded.secure_url,
            websiteUrl: metadata.brandUrl || null,
            firstSeenMediaId: media._id
          });
          console.log(`🏷️   Brand "${brandName}" logo curated → ${logoUploaded.secure_url}`);
        } else {
          console.warn('⚠️  brandLogo uploaded without a brand name — skipping curation');
        }
      } catch (err) {
        // Non-fatal — detection should still proceed if logo upload fails.
        console.warn('⚠️  brandLogo upload/curation failed:', err.message);
      }
    }

    const run = await DetectRun.create({
      advertiserId: req.advertiserId,
      brandId:      media.brandId || null,
      mediaId:      media._id,
      status:       'queued',
      stage:        'queued',
      trigger:      'upload'
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
    // Tenant-scoped lookup; falls back to parent-Media check for legacy
    // runs that pre-date the phase-1 backfill.
    const runLean = await assertRunInTenant(req.params.runId, req);
    const run = await DetectRun.findById(runLean._id);

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
    res.status(err.status || 500).json({ error: 'Failed to fetch status', message: err.message });
  }
});

// Assemble the unified result the frontend renders. Pulls the run's
// associated Media doc + each per-stage artifact and flattens them into the
// shape the existing UI code reads. New artifact-aware UIs can fetch
// individual collections directly.
async function assembleResult(run) {
  const media = await Media.findById(run.mediaId);
  if (!media) return null;

  // Phase 1.7 — read ALL ProductMatchArtifact docs for the run (one per refined
  // product). Sort with primary first (catalog winners outrank by combined
  // score, then by certainty). Surface .productMatches (legacy primary alias)
  // AND .productMatchesAll (full list) so existing UIs see no change while
  // multi-product-aware UIs can iterate.
  const [detection, crops, extended, allMatches, overlayZones] = await Promise.all([
    DetectionArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    CropArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    ExtendedCropArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean(),
    ProductMatchArtifact.find({ runId: run._id }).sort({ createdAt: 1 }).lean(),
    OverlayZoneArtifact.findOne({ runId: run._id }).sort({ createdAt: -1 }).lean()
  ]);

  // Rank matches: catalog winners first, then by combined catalog score,
  // then by certainty. The first entry is the legacy "primary" exposed
  // under .productMatches.
  const rankedRaw = (allMatches || []).slice().sort((a, b) => {
    const aCat = a.winner === 'catalog' ? 1 : 0;
    const bCat = b.winner === 'catalog' ? 1 : 0;
    if (aCat !== bCat) return bCat - aCat;
    const aScore = a.catalogCombinedScore ?? a.identification?.certainty ?? 0;
    const bScore = b.catalogCombinedScore ?? b.identification?.certainty ?? 0;
    return bScore - aScore;
  });

  // Phase 2g — hydrate every ranked match from canonical FK targets
  // (CatalogProduct + Category + Brand). The legacy snapshot field paths
  // on each entry now carry canonical data; the separate `catalog` and
  // `categoryDoc` fields below expose the raw FK rows for clients that
  // want them directly.
  const rankedMatches = await Promise.all(rankedRaw.map(m => hydrateMatch(m)));
  const match = rankedMatches[0] || null;

  const catalogIds = [...new Set(rankedRaw.map(m => m.catalogProductId).filter(Boolean).map(String))];
  const categoryIds = [...new Set(rankedRaw.map(m => m.categoryId).filter(Boolean).map(String))];
  const [catalogDocs, categoryDocs] = await Promise.all([
    catalogIds.length ? CatalogProduct.find({ _id: { $in: catalogIds } }).lean() : [],
    categoryIds.length ? Category.find({ _id: { $in: categoryIds } }).lean() : []
  ]);
  const catalogById = new Map(catalogDocs.map(d => [String(d._id), d]));
  const categoryById = new Map(categoryDocs.map(d => [String(d._id), d]));

  const stageTimings = run.stageTimings && typeof run.stageTimings.toObject === 'function'
    ? run.stageTimings.toObject()
    : (run.stageTimings || {});

  return {
    type:       media.fileType,
    imageUrl:   detection?.imageUrl || media.fileUrl,
    videoUrl:   detection?.videoUrl || (media.fileType === 'video' ? media.fileUrl : undefined),
    width:      detection?.width  || media.width  || 0,
    height:     detection?.height || media.height || 0,

    rights:     media.rights || { approved: false },

    heroFrameSec:     detection?.heroFrameSec     ?? null,
    heroReason:       detection?.heroReason       || null,
    videoDurationSec: detection?.videoDurationSec ?? null,

    products:   detection?.yoloProducts || [],
    refinedProducts: detection?.refinedProducts || [],   // Phase 1.6
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

    // Legacy alias — primary match flattened into the shape existing UIs read.
    productMatches: match
      ? {
          query:        match.query,
          providers:    match.providers || {},
          errors:       match.errors    || {},
          totalMatches: match.totalMatches || 0,
          identification: match.identification || null
        }
      : null,

    // Phase 1.7 — full list of per-product matches with all enrichment surfaces.
    // Multi-product-aware UIs iterate this; each entry is one refined product's
    // complete match record.
    productMatchesAll: rankedMatches.map(m => ({
      productIndex:         m.productIndex || null,
      query:                m.query || null,
      identification:       m.identification || null,
      outcome:              m.outcome || null,
      outcomeReasoning:     m.outcomeReasoning || null,
      winner:               m.winner || null,
      matchSource:          m.matchSource || null,
      catalogProductId:     m.catalogProductId || null,
      categoryId:           m.categoryId || null,
      catalogMatch:         m.catalogMatch || null,
      catalogVisualScore:   m.catalogVisualScore   ?? null,
      catalogCombinedScore: m.catalogCombinedScore ?? null,
      brandCategory:        m.brandCategory || null,
      brandReviews:         m.brandReviews || null,
      productReviews:       m.productReviews || null,
      categoryReviews:      m.categoryReviews || null,
      enrichmentTiers:      m.enrichmentTiers || [],
      recommendedProducts:  m.recommendedProducts || [],
      // Phase 2g — populated FK data (canonical source of truth).
      // Consumers should prefer these over the snapshot fields above.
      catalog:     m.catalogProductId ? (catalogById.get(String(m.catalogProductId)) || null) : null,
      categoryDoc: m.categoryId       ? (categoryById.get(String(m.categoryId))       || null) : null
    })),

    // Phase 0a — Media classification block (provenance + run-scoped detect summary)
    mediaClassification: media.classification || null,

    overlayZones: overlayZones?.zones || {},

    transcript: detection?.transcript || null,
    stageTimings,

    // Origin metadata — surfaced so the UI can show "Instagram post"
    // vs "Manual upload" pills and (for IG-sourced) link out to the
    // permalink and show creator handle / posted date.
    mediaSource: {
      source:        media.source,
      externalId:    media.externalId,
      sourceUrl:     media.sourceUrl  || null,
      permalink:     media.metadata?.permalink || null,
      postedAt:      media.metadata?.postedAt || null,
      creatorHandle: media.metadata?.creatorHandle || null,
      postType:      media.metadata?.postType || null
    }
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
// Phase A-1 — exported so the Media Library detail endpoint
// (routes/media.js GET /:mediaId/detect) can reuse the same assembled
// shape that /api/detect/status/:runId returns. Keyed by DetectRun.
module.exports.assembleResult = assembleResult;
