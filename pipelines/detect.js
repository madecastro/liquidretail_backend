// Detect pipeline — operates on a DetectRun (Media-keyed). Writes per-stage
// artifacts to dedicated collections so each pipeline stage owns its own
// data. The frontend's status endpoint assembles a unified result on the fly
// (see routes/detect.js).
//
// Lifecycle (run.stage values):
//   queued → detect-fanout → crop-judge → enrich-fanout → finalize → done
//
// Within each phase, sub-stages run as follows. Each sub-stage's duration is
// recorded in run.stageTimings under its own key (e.g. yolo, subjects-text,
// product-match) so the UI's timing panel still shows per-stage breakdowns.
//
//   detect-fanout (Promise.allSettled)
//     image:  [yolo → yolo-identify]  ‖  [subjects-text]
//     video:  [yolo-video → yolo-identify → subjects-text(hero)]  ‖  [transcribe → ner]
//
//   crop-judge (sequential — judge depends on YOLO + subjects + crops)
//     smart-crops → judge → CropArtifact persist
//
//   enrich-fanout (Promise.allSettled — independent post-judge work)
//     [extended-crops → judge-extended → overlay-zones → ExtendedCrop+OverlayZone persist]
//     ‖  [product-match → ProductMatchArtifact persist + side-effects]
//
// Each artifact is written immediately after its branch completes so a run
// that fails midway still leaves the partial work persisted.
//
// Errors inside a stage are caught locally and degrade the run gracefully
// (e.g. YOLO failure → products=[], pipeline continues). Promise.allSettled
// at fan-out boundaries means one branch can still succeed if its sibling
// blows up entirely.

const { detectMultipleProducts, detectFromVideo } = require('../services/yoloService');
const { uploadBufferToCloudinary } = require('../services/cloudinaryService');
const { detectSubjectsAndText } = require('../services/subjectTextService');
const { generateSmartCrops, computeSafeRect } = require('../services/smartCropService');
const { judgeDetections, judgeExtendedCrops } = require('../services/judgeService');
const { generateExtendedCrops } = require('../services/extendedCropsService');
const { transcribeAudio } = require('../services/whisperService');
const { extractEntities } = require('../services/nerService');
const { findProductMatches } = require('../services/productMatchService');
const { analyzeOverlayZones } = require('../services/overlayZoneService');
const { identifyYoloDetections } = require('../services/yoloIdentifyService');
const { identifyYoloDetectionsGemini, isEnabled: isGeminiIdentifyEnabled } = require('../services/geminiIdentifyService');
const { reconcileEnrichments } = require('../services/enrichmentReconciler');
const { refineDetectionCrops } = require('../services/cropRefineService');
const { maybePostMatchReply } = require('../services/instagramCommentService');
const { maybeCreateDraftFromMatch } = require('../services/catalogProductDraftService');
// Brand catalog mutations no longer happen inside the detect pipeline
// — Brand creation + enrichment is a user-driven concern triggered by
// POST /api/brand (or PATCH /api/brand/:id). Detect can still
// IDENTIFY a brand name on the Media, but linking that to the
// Advertiser's brand catalog is the picker / members UI's job.

const Media               = require('../models/Media');
const DetectionArtifact   = require('../models/DetectionArtifact');
const CropArtifact        = require('../models/CropArtifact');
const ExtendedCropArtifact = require('../models/ExtendedCropArtifact');
const ProductMatchArtifact = require('../models/ProductMatchArtifact');
const OverlayZoneArtifact  = require('../models/OverlayZoneArtifact');

const { downloadBuffer } = require('./shared');

// ──────────────────────────────────────────────────────────────
//  Entry point — worker calls this for every queued DetectRun
// ──────────────────────────────────────────────────────────────
async function processDetectRun(run) {
  const media = await Media.findById(run.mediaId);
  if (!media) throw new Error(`Media ${run.mediaId} not found`);
  if (!media.fileUrl) throw new Error(`Media ${run.mediaId} has no fileUrl`);

  const buffer = await downloadBuffer(media.fileUrl, 'file-download');

  run.stageTimings = {};

  if (media.fileType === 'video') {
    await runVideoPipeline(run, media, buffer);
  } else {
    await runImagePipeline(run, media, buffer);
  }

  run.status = 'completed';
  run.stage = 'done';
  run.completedAt = new Date();
  await run.save();

  const totalMs = Object.values(run.stageTimings || {}).reduce((a, n) => a + n, 0);
  console.log(`🎉 DetectRun ${run._id} completed in ${totalMs}ms`);
}

// ──────────────────────────────────────────────────────────────
//  Image pipeline
// ──────────────────────────────────────────────────────────────
async function runImagePipeline(run, media, buffer) {
  const sourceUrl = media.fileUrl;

  // ── Phase 1: detect fan-out ──
  await setRunPhase(run, 'detect-fanout');
  const [yoloRes, subjectsRes] = await Promise.allSettled([
    runYoloChain(run, buffer, media),
    runSubjectsTextChain(run, sourceUrl, media)
  ]);
  if (yoloRes.status === 'rejected')     console.warn('⚠️  YOLO chain rejected:', yoloRes.reason?.message);
  if (subjectsRes.status === 'rejected') console.warn('⚠️  Subjects/text chain rejected:', subjectsRes.reason?.message);

  const yoloChainOut = yoloRes.status === 'fulfilled'
    ? yoloRes.value
    : { products: [], refinedProducts: [] };
  const products = yoloChainOut.products;
  const refinedProducts = yoloChainOut.refinedProducts;
  const { subjects, text, background } = subjectsRes.status === 'fulfilled'
    ? subjectsRes.value
    : { subjects: [], text: [], background: null };

  const imgW = products[0]?.imgWidth  || 1024;
  const imgH = products[0]?.imgHeight || 768;

  // Persist Media dimensions so consumers can query without loading artifacts.
  media.width  = imgW;
  media.height = imgH;
  await media.save();

  // ── Detection artifact (preliminary — primary subject filled in after judge) ──
  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    type: 'image',
    width: imgW, height: imgH,
    imageUrl: sourceUrl,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    refinedProducts,
    subjects, text, background
  });

  // ── Phase 2: crop-judge bridge ──
  await setRunPhase(run, 'crop-judge');

  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);

  const crops = await timeStage(run, 'smart-crops', async () =>
    generateSmartCrops(imgW, imgH, subjects, text, safeRect)
  );

  const judge = await timeStage(run, 'judge', async () => {
    try {
      return await judgeDetections({ imageUrl: sourceUrl, products, subjects, text, crops, safeRect });
    } catch (err) { console.warn('⚠️  Judge:', err.message); return null; }
  });

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  // Backfill the detection artifact with judge-arbitrated primary + safeRect.
  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Phase 3: enrich fan-out ──
  await setRunPhase(run, 'enrich-fanout');
  const [extendedRes, matchRes] = await Promise.allSettled([
    runExtendedAndOverlayChain(run, media, sourceUrl, null, crops, judge, primarySubjectDesc, background, text, false),
    runProductMatchChain(run, media, sourceUrl, products, primarySubjectDesc, text)
  ]);
  if (extendedRes.status === 'rejected') console.warn('⚠️  Extended/overlay chain rejected:', extendedRes.reason?.message);
  if (matchRes.status === 'rejected')    console.warn('⚠️  Product match chain rejected:',     matchRes.reason?.message);

  const { extendedDoc, overlayDoc } = extendedRes.status === 'fulfilled'
    ? extendedRes.value
    : { extendedDoc: null, overlayDoc: null };
  const { productMatches, matchDoc } = matchRes.status === 'fulfilled'
    ? matchRes.value
    : { productMatches: null, matchDoc: null };

  // V3 #3 — auto-comment on the original IG post when this Media came
  // from Instagram and produced a confident product_match with a
  // productUrl. Fire-and-forget; the service guards on brand opt-in,
  // daily cap, and idempotency. Errors are swallowed so detect never
  // fails because of an opportunistic comment.
  if (productMatches && media.source === 'instagram') {
    maybePostMatchReply({ media, productMatch: productMatches })
      .catch(err => console.warn(`   ⚠️  comment-reply async failure: ${err.message}`));
  }

  // Upload-4 — when this brand opted into autoCreateFromDetect AND
  // the match was confident AND no existing catalog row won, write a
  // draft CatalogProduct so the SKU shows up in the brand's catalog
  // for completion (price + productUrl). Fire-and-forget; the service
  // guards on opt-in / outcome / certainty internally.
  if (productMatches) {
    maybeCreateDraftFromMatch({
      media,
      productMatch:  productMatches,
      sceneImageUrl: sourceUrl,
      yoloProducts:  products
    }).catch(err => console.warn(`   ⚠️  draft auto-create async failure: ${err.message}`));
  }

  // ── Finalize ──
  await setRunPhase(run, 'finalize');
  await updateMediaLatestArtifacts(media, {
    detection:    detectionDoc._id,
    crops:        cropDoc._id,
    extended:     extendedDoc?._id,
    match:        matchDoc?._id,
    overlayZones: overlayDoc?._id
  });
}

// ──────────────────────────────────────────────────────────────
//  Video pipeline
// ──────────────────────────────────────────────────────────────
async function runVideoPipeline(run, media, buffer) {
  const sourceVideoUrl = media.fileUrl;

  // ── Phase 1: detect fan-out ──
  // Branch A: yolo-video → yolo-identify → subjects-text(hero) — sequential
  //   within branch because subjects-text needs the hero frame URL.
  // Branch B: transcribe → ner — independent of YOLO, runs concurrently.
  await setRunPhase(run, 'detect-fanout');

  const yoloChain = (async () => {
    const yoloOut = await runYoloVideoChain(run, buffer, media);
    if (yoloOut.products.length) {
      // Phase 1.5c — dual-engine enrichment (video). Same parallel pattern
      // as the image path; reconciler merges into engines.reconciled.products.
      await timeStage(run, 'yolo-identify', async () => {
        const hints = { brand: media.metadata?.brand, category: media.metadata?.category };
        const tasks = [identifyYoloDetections(yoloOut.products, hints).catch(err => {
          console.warn('⚠️  GPT yolo-identify (video):', err.message);
          return null;
        })];
        if (isGeminiIdentifyEnabled()) {
          tasks.push(identifyYoloDetectionsGemini(yoloOut.products, hints).catch(err => {
            console.warn('⚠️  Gemini yolo-identify (video):', err.message);
            return null;
          }));
        } else {
          yoloOut.products.forEach(p => { p.engines = p.engines || {}; p.engines.gemini = null; });
        }
        await Promise.all(tasks);
        reconcileEnrichments(yoloOut.products);
        const productCount = yoloOut.products.reduce((n, d) => n + (d.engines?.reconciled?.products?.length || 0), 0);
        console.log(`🏷️   YOLO identify (video, dual-engine): ${yoloOut.products.length} crop(s) → ${productCount} reconciled product(s)`);
      });
    }
    let subjects = [], text = [], background = null;
    if (yoloOut.heroImageUrl) {
      const st = await runSubjectsTextChain(run, yoloOut.heroImageUrl, media);
      subjects = st.subjects; text = st.text; background = st.background;
    }
    return { ...yoloOut, subjects, text, background };
  })();

  const transcribeChain = runTranscribeNerChain(run, buffer, media);

  const [yoloRes, transcribeRes] = await Promise.allSettled([yoloChain, transcribeChain]);
  if (yoloRes.status === 'rejected')       console.warn('⚠️  YOLO chain rejected:',       yoloRes.reason?.message);
  if (transcribeRes.status === 'rejected') console.warn('⚠️  Transcribe chain rejected:', transcribeRes.reason?.message);

  const yoloOut = yoloRes.status === 'fulfilled' ? yoloRes.value : {
    products: [], imgW: 1024, imgH: 768, heroImageUrl: null,
    heroFrameSec: null, heroReason: null, videoDurationSec: null,
    subjects: [], text: [], background: null
  };
  const { transcript, entities } = transcribeRes.status === 'fulfilled'
    ? transcribeRes.value
    : { transcript: null, entities: [] };

  const { products, imgW, imgH, heroImageUrl, heroFrameSec, heroReason, videoDurationSec, subjects, text, background } = yoloOut;

  // Persist Media dimensions + duration.
  media.width = imgW; media.height = imgH;
  if (videoDurationSec) media.durationSec = videoDurationSec;
  await media.save();

  const detectionDoc = await DetectionArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    type: 'video',
    width: imgW, height: imgH,
    imageUrl: heroImageUrl,                 // hero frame (the canonical "still" for this video)
    videoUrl: sourceVideoUrl,
    heroFrameSec, heroReason, videoDurationSec,
    yoloProducts: products.map(({ cropBuffer, ...p }) => p),
    refinedProducts: [],                    // Phase 1.6 is image-only for v1; video uses yoloIdentifications fallback in Phase 1.7
    subjects, text, background,
    transcript: transcript ? {
      text: transcript.text,
      duration: transcript.duration,
      segments: transcript.segments,
      entities
    } : null
  });

  // ── Phase 2: crop-judge bridge ──
  await setRunPhase(run, 'crop-judge');

  const safeRect = computeSafeRect(products, subjects, imgW, imgH, text);
  if (safeRect) console.log(`🛟  Safe envelope: (${safeRect.x1.toFixed(0)}, ${safeRect.y1.toFixed(0)}) → (${safeRect.x2.toFixed(0)}, ${safeRect.y2.toFixed(0)})`);

  const crops = await timeStage(run, 'smart-crops', async () => {
    const c = generateSmartCrops(imgW, imgH, subjects, text, safeRect);
    // Attach a Cloudinary video-transform URL to each crop candidate so the UI
    // can preview the fully cropped clip.
    for (const ratio of Object.keys(c)) {
      for (const cand of c[ratio]) cand.videoUrl = buildCloudinaryCropUrl(sourceVideoUrl, cand);
    }
    return c;
  });

  let judge = null;
  if (heroImageUrl) {
    judge = await timeStage(run, 'judge', async () => {
      try {
        return await judgeDetections({ imageUrl: heroImageUrl, products, subjects, text, crops, safeRect });
      } catch (err) { console.warn('⚠️  Judge:', err.message); return null; }
    });
  }

  const primarySubjectId   = resolvePrimarySubjectId(subjects, judge);
  const primarySubjectDesc = resolvePrimarySubjectDesc(subjects, judge);

  detectionDoc.safeRect = safeRect || null;
  detectionDoc.primarySubjectId = primarySubjectId;
  detectionDoc.primarySubjectDesc = primarySubjectDesc;
  await detectionDoc.save();

  const cropDoc = await CropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    smartCrops: crops,
    judge,
    winners: {
      '5:4': judge?.crop_5_4?.winnerId || null,
      '1:1': judge?.crop_1_1?.winnerId || null,
      '4:5': judge?.crop_4_5?.winnerId || null
    }
  });

  // ── Phase 3: enrich fan-out ──
  await setRunPhase(run, 'enrich-fanout');
  const [extendedRes, matchRes] = await Promise.allSettled([
    runExtendedAndOverlayChain(run, media, heroImageUrl, sourceVideoUrl, crops, judge, primarySubjectDesc, background, text, true),
    runProductMatchChain(run, media, heroImageUrl, products, primarySubjectDesc, text)
  ]);
  if (extendedRes.status === 'rejected') console.warn('⚠️  Extended/overlay chain rejected:', extendedRes.reason?.message);
  if (matchRes.status === 'rejected')    console.warn('⚠️  Product match chain rejected:',     matchRes.reason?.message);

  const { extendedDoc, overlayDoc } = extendedRes.status === 'fulfilled'
    ? extendedRes.value
    : { extendedDoc: null, overlayDoc: null };
  const { productMatches, matchDoc } = matchRes.status === 'fulfilled'
    ? matchRes.value
    : { productMatches: null, matchDoc: null };

  if (productMatches && media.source === 'instagram') {
    maybePostMatchReply({ media, productMatch: productMatches })
      .catch(err => console.warn(`   ⚠️  comment-reply async failure: ${err.message}`));
  }
  if (productMatches) {
    maybeCreateDraftFromMatch({
      media,
      productMatch:  productMatches,
      sceneImageUrl: heroImageUrl,
      yoloProducts:  products
    }).catch(err => console.warn(`   ⚠️  draft auto-create async failure: ${err.message}`));
  }

  // ── Finalize ──
  await setRunPhase(run, 'finalize');
  await updateMediaLatestArtifacts(media, {
    detection:    detectionDoc._id,
    crops:        cropDoc._id,
    extended:     extendedDoc?._id,
    match:        matchDoc?._id,
    overlayZones: overlayDoc?._id
  });
}

// ──────────────────────────────────────────────────────────────
//  Stage chains — each is a self-contained leaf of the fan-out
//  graph. They share the run object only to record per-sub-stage
//  timings into run.stageTimings; persistence to MongoDB happens
//  at phase boundaries (setRunPhase) so concurrent branches don't
//  race on save().
// ──────────────────────────────────────────────────────────────

async function runYoloChain(run, buffer, media) {
  const products = await timeStage(run, 'yolo', async () => {
    try {
      const yolo = await detectMultipleProducts(buffer);
      console.log(`🔍 YOLO: ${yolo.detections.length} product(s)`);
      return yolo.detections;
    } catch (err) { console.warn('⚠️  YOLO:', err.message); return []; }
  });

  if (products.length) {
    // Phase 1.5c — dual-engine enrichment. GPT-4.1 and Gemini Vision run in
    // parallel on the same crops; reconciler merges per-detection products[]
    // into engines.reconciled.products[] and updates the legacy
    // det.identification alias. Gemini failures are non-fatal (GPT carries
    // the run with single-engine penalty applied during reconciliation).
    await timeStage(run, 'yolo-identify', async () => {
      const hints = { brand: media.metadata?.brand, category: media.metadata?.category };
      const tasks = [identifyYoloDetections(products, hints).catch(err => {
        console.warn('⚠️  GPT yolo-identify:', err.message);
        return null;
      })];
      if (isGeminiIdentifyEnabled()) {
        tasks.push(identifyYoloDetectionsGemini(products, hints).catch(err => {
          console.warn('⚠️  Gemini yolo-identify:', err.message);
          return null;
        }));
      } else {
        // Mark every detection as having no Gemini engine so reconciler
        // applies the single-engine penalty to GPT-only outputs.
        products.forEach(p => { p.engines = p.engines || {}; p.engines.gemini = null; });
      }
      await Promise.all(tasks);
      reconcileEnrichments(products);
      const summary = products.reduce((acc, d) => {
        const r = d.engines?.reconciled?.products || [];
        acc.totalProducts += r.length;
        acc.agreed       += r.filter(p => p.agreement === 'agree').length;
        acc.gptOnly      += r.filter(p => p.agreement === 'gpt-only').length;
        acc.geminiOnly   += r.filter(p => p.agreement === 'gemini-only').length;
        return acc;
      }, { totalProducts: 0, agreed: 0, gptOnly: 0, geminiOnly: 0 });
      console.log(
        `🏷️   YOLO identify (dual-engine): ${products.length} crop(s) → ` +
        `${summary.totalProducts} reconciled product(s) ` +
        `[${summary.agreed} agreed, ${summary.gptOnly} gpt-only, ${summary.geminiOnly} gemini-only]`
      );
    });
  }

  // Phase 1.6 — bbox refinement on real-product survivors. Image-only for
  // v1; video falls back to yoloIdentifications in Phase 1.7 (the
  // microservice samples detections across frames so there's no single
  // source URL to crop against the bboxes).
  let refinedProducts = [];
  const survivors = products.filter(p =>
    p.identification?.label && p.identification.label !== 'non-product'
  );
  if (survivors.length && media.fileType === 'image') {
    refinedProducts = await timeStage(run, 'crop-refine', async () => {
      try {
        const refined = await refineDetectionCrops(survivors, media.fileUrl);
        console.log(`✂️   crop-refine: ${refined.length} refined product(s) from ${survivors.length} surviving detection(s)`);
        return refined;
      } catch (err) {
        console.warn('⚠️  crop-refine:', err.message);
        return [];
      }
    });
  }

  return { products, refinedProducts };
}

async function runYoloVideoChain(run, buffer, media) {
  return await timeStage(run, 'yolo-video', async () => {
    try {
      const yolo = await detectFromVideo(buffer, media.fileName);
      let heroImageUrl = null;
      if (yolo.heroFrameBase64) {
        const heroBuf = Buffer.from(yolo.heroFrameBase64, 'base64');
        const up = await uploadBufferToCloudinary(heroBuf, { resourceType: 'image' });
        heroImageUrl = up.secure_url;
        console.log(`🖼️  Hero frame @ ${yolo.heroFrameSec}s (${yolo.heroReason}): ${heroImageUrl}`);
      }
      console.log(`🔍 YOLO (video): ${yolo.detections.length} product(s)`);
      return {
        products:         yolo.detections,
        imgW:             yolo.width  || 1024,
        imgH:             yolo.height || 768,
        heroFrameSec:     yolo.heroFrameSec,
        heroReason:       yolo.heroReason,
        videoDurationSec: yolo.videoDurationSec,
        heroImageUrl
      };
    } catch (err) {
      console.warn('⚠️  YOLO video:', err.message);
      return {
        products: [], imgW: 1024, imgH: 768, heroImageUrl: null,
        heroFrameSec: null, heroReason: null, videoDurationSec: null
      };
    }
  });
}

async function runSubjectsTextChain(run, imageUrl, media) {
  return await timeStage(run, 'subjects-text', async () => {
    if (!imageUrl) return { subjects: [], text: [], background: null };
    try {
      const st = await detectSubjectsAndText(imageUrl, {
        brand: media.metadata?.brand,
        category: media.metadata?.category,
        caption: media.metadata?.caption
      });
      return { subjects: st.subjects, text: st.text, background: st.background };
    } catch (err) {
      console.warn('⚠️  Subject/text:', err.message);
      return { subjects: [], text: [], background: null };
    }
  });
}

async function runTranscribeNerChain(run, buffer, media) {
  let transcript = null;
  let entities = [];
  await timeStage(run, 'transcribe', async () => {
    try {
      transcript = await transcribeAudio(buffer, media.fileName);
      if (transcript) console.log(`🎙️  Transcript: ${transcript.segments.length} segments, ${transcript.duration.toFixed(1)}s`);
    } catch (err) { console.warn('⚠️  Transcription:', err.message); }
  });
  if (transcript) {
    await timeStage(run, 'ner', async () => {
      try {
        entities = await extractEntities(transcript);
        console.log(`🏷️  NER: ${entities.length} entities`);
      } catch (err) { console.warn('⚠️  NER:', err.message); }
    });
  }
  return { transcript, entities };
}

async function runProductMatchChain(run, media, sourceImageUrl, products, primarySubjectDesc, text) {
  const productMatches = await timeStage(run, 'product-match', async () => {
    try {
      const result = await findProductMatches({
        brand:          media.metadata?.brand,
        brandUrl:       media.metadata?.brandUrl,
        advertiserId:   media.advertiserId || null,
        brandId:        media.brandId || null,
        category:       media.metadata?.category,
        caption:        media.metadata?.caption,
        primarySubject: primarySubjectDesc,
        textDetected:   (text || []).map(t => t.content).filter(Boolean),
        imageUrl:       sourceImageUrl,
        // YOLO+GPT enriched identifications drive the decision tree
        // (multi-brand contention, confidence comparison vs Gemini).
        yoloIdentifications: products
      });
      console.log(`🔗 Product match: ${result.totalMatches} total across ${Object.keys(result.providers).length} provider(s)${result.matchSource ? ` (source=${result.matchSource})` : ''}`);
      return result;
    } catch (err) {
      console.warn('⚠️  Product match:', err.message);
      return null;
    }
  });

  const matchDoc = productMatches ? await ProductMatchArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    query:            productMatches.query,
    providers:        productMatches.providers,
    errors:           productMatches.errors,
    totalMatches:     productMatches.totalMatches,
    identification:   productMatches.identification || null,
    outcome:          productMatches.outcome || null,
    outcomeReasoning: productMatches.outcomeReasoning || null,
    winner:           productMatches.winner || null,
    brandCategory:    productMatches.brandCategory || null,
    brandReviews:     productMatches.brandReviews || null,
    matchSource:      productMatches.matchSource || null,
    catalogProductId: productMatches.catalogMatch?.product?._id || null,
    catalogMatch:     productMatches.catalogMatch ? {
      productId:   productMatches.catalogMatch.product._id,
      title:       productMatches.catalogMatch.product.title,
      score:       productMatches.catalogMatch.score,
      reasoning:   productMatches.catalogMatch.reasoning,
      signalsUsed: productMatches.catalogMatch.signalsUsed
    } : null,
    productReviews:   productMatches.productReviews || null
  }) : null;

  return { productMatches, matchDoc };
}

async function runExtendedAndOverlayChain(run, media, sourceImageUrl, sourceVideoUrl, crops, judge, primarySubjectDesc, background, text, isVideo) {
  let extendedCandidates = {}, extendedErrors = {}, extendedJudgeRes = {};

  if (sourceImageUrl) {
    await timeStage(run, 'extended-crops', async () => {
      try {
        const { candidates, errors } = await generateExtendedCrops({
          sourceImageUrl, sourceVideoUrl,
          smartCrops: crops, judge, primarySubject: primarySubjectDesc,
          background, isVideo
        });
        extendedCandidates = candidates;
        extendedErrors = errors;
        const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
        console.log(`🖼️   Extended crops${isVideo ? ' (video)' : ''}: ${totalCandidates} candidate(s) across ${Object.keys(extendedCandidates).length} ratios`);
      } catch (err) { console.warn('⚠️  Extended crops:', err.message); }
    });

    const totalCandidates = Object.values(extendedCandidates).reduce((a, arr) => a + arr.length, 0);
    if (totalCandidates > 0) {
      await timeStage(run, 'judge-extended', async () => {
        try {
          extendedJudgeRes = await judgeExtendedCrops({
            candidates: extendedCandidates,
            sourceImageUrl,
            text,
            primarySubject: primarySubjectDesc
          });
        } catch (err) { console.warn('⚠️  Judge extended:', err.message); }
      });
    }
  }

  const extendedDoc = await ExtendedCropArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    candidates: extendedCandidates,
    errors: extendedErrors,
    judge: extendedJudgeRes,
    selectedWinners: deriveSelectedWinners(extendedCandidates, extendedJudgeRes)
  });

  let overlayZones = {};
  if (sourceImageUrl) {
    await timeStage(run, 'overlay-zones', async () => {
      try {
        overlayZones = await runOverlayZoneAnalysis({
          sourceImageUrl, crops, judge, extendedCrops: extendedCandidates
        });
      } catch (err) { console.warn('⚠️  Overlay zones:', err.message); }
    });
  }

  const overlayDoc = await OverlayZoneArtifact.create({
    mediaId: media._id, runId: run._id, advertiserId: media.advertiserId, brandId: media.brandId,
    zones: overlayZones
  });

  return { extendedDoc, overlayDoc };
}

// ──────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────

// Phase boundary — writes run.stage and persists. Called at each fan-out /
// bridge transition; sub-stage timings within a phase don't trigger saves
// so concurrent branches can't race on Mongoose's serialization.
async function setRunPhase(run, phase) {
  run.stage = phase;
  await run.save();
  console.log(`   ⇒ phase: ${phase}`);
}

// Sub-stage timing wrapper. Records elapsed ms in run.stageTimings under
// `name`, even when the inner fn throws (try/finally). Multiple stages
// within the same phase can run concurrently and each safely accumulates
// its own duration — Node's single-threaded event loop ensures the
// in-memory mutations are atomic; persistence happens on the next
// setRunPhase() save.
async function timeStage(run, name, fn) {
  const t0 = Date.now();
  console.log(`   → ${name}`);
  try {
    return await fn();
  } finally {
    const elapsed = Date.now() - t0;
    run.stageTimings = run.stageTimings || {};
    run.stageTimings[name] = (run.stageTimings[name] || 0) + elapsed;
    run.markModified('stageTimings');
  }
}

// Cloudinary video-transform URL: crop every frame to a given rect.
function buildCloudinaryCropUrl(videoUrl, crop) {
  if (!videoUrl || !videoUrl.includes('/upload/')) return null;
  const w = Math.max(1, crop.x2 - crop.x1);
  const h = Math.max(1, crop.y2 - crop.y1);
  const transform = `c_crop,w_${w},h_${h},x_${crop.x1},y_${crop.y1}`;
  if (/\/v\d+\//.test(videoUrl)) {
    return videoUrl.replace(/\/(v\d+\/)/, `/${transform}/$1`);
  }
  return videoUrl.replace('/upload/', `/upload/${transform}/`);
}

// Layout-preprocessing stage. Picks the input images (base-ratio judge winners
// + both Gemini-extended candidates per extended ratio) and asks Gemini Vision
// for overlay zones per image, in parallel.
//
// Output shape (schemaVersion 3.0) — per-ratio ARRAY of variant entries so
// adding a new provider is purely additive and consumers can iterate without
// knowing variant-key names ahead of time:
//   {
//     '<ratio>': [
//       { provider, variant, candidateId, imageUrl, analysis }  // ...or null analysis on per-image failure
//     ]
//   }
//
// TODO — video-specific refinements. Currently both the image and video
// pipelines run this stage identically against a single still (hero frame for
// video), which means zones are derived from a single moment in time and can
// collide with the subject later in the clip. In priority order:
//   A. Pass the cross-frame `safeRect` (already computed on video jobs — union
//      of YOLO detections across frames + primary GPT subjects) into the
//      Gemini prompt as an explicit forbidden rect. Eliminates the worst
//      class of failure (overlay ends up under the subject mid-playback).
//   B. Multi-frame analysis. Sample 3 frames (start / middle / end) per
//      ratio, union the forbidden rects, intersect the safe zones.
//   C. Analyze the actually-rendered self-underlay video. Use Cloudinary
//      `so_<sec>` transform to extract N frames from the composed output URL.
async function runOverlayZoneAnalysis({ sourceImageUrl, crops, judge, extendedCrops }) {
  const inputs = pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops });
  if (!inputs.length) return {};

  const settled = await Promise.allSettled(inputs.map(i =>
    analyzeOverlayZones({ imageUrl: i.imageUrl, label: i.label, ratio: i.ratio })
  ));

  const artifact = {};
  inputs.forEach((input, idx) => {
    const analysis = settled[idx].status === 'fulfilled' ? settled[idx].value : null;
    artifact[input.ratio] = artifact[input.ratio] || [];
    artifact[input.ratio].push({
      provider:    input.provider,
      variant:     input.variant,
      candidateId: input.candidateId,
      imageUrl:    input.imageUrl,
      analysis
    });
  });

  const ok = Object.values(artifact).flat().filter(e => e.analysis).length;
  console.log(`🎯 Overlay zones: ${ok}/${inputs.length} analyses complete`);
  return artifact;
}

function pickOverlayZoneInputs({ sourceImageUrl, crops, judge, extendedCrops }) {
  const inputs = [];
  if (!sourceImageUrl) return inputs;

  const baseRatios = [
    { ratio: '5:4', judgeKey: 'crop_5_4' },
    { ratio: '1:1', judgeKey: 'crop_1_1' },
    { ratio: '4:5', judgeKey: 'crop_4_5' }
  ];
  for (const { ratio, judgeKey } of baseRatios) {
    const winnerId = judge?.[judgeKey]?.winnerId;
    const list = crops?.[ratio] || [];
    const winner = list.find(c => c.id === winnerId) || list[0];
    if (!winner) continue;
    const imageUrl = buildCloudinaryCropUrl(sourceImageUrl, winner);
    if (!imageUrl) continue;
    inputs.push({
      ratio, provider: null, variant: 'base', candidateId: winner.id, imageUrl,
      label: `${ratio} base`
    });
  }

  for (const ratio of ['9:16', '1.91:1']) {
    const list = extendedCrops?.[ratio] || [];
    for (const variant of ['extension', 'generation']) {
      const cand = list.find(c => c.provider === 'gemini' && c.variant === variant);
      if (!cand?.imageUrl) continue;
      inputs.push({
        ratio, provider: 'gemini', variant, candidateId: cand.id, imageUrl: cand.imageUrl,
        label: `${ratio} gem-${variant}`
      });
    }
  }
  return inputs;
}

// Primary-subject resolution. Judge.subjects.primaryId is preferred (the
// judge sees YOLO + GPT subjects together and can break ties). Fall back to
// GPT's role-based selection.
function resolvePrimarySubjectId(subjects, judge) {
  const judgeId = judge?.subjects?.primaryId;
  if (judgeId && subjects?.find(s => s.id === judgeId)) return judgeId;
  return subjects?.find(s => s.role === 'primary')?.id || null;
}
function resolvePrimarySubjectDesc(subjects, judge) {
  if (!subjects?.length) return null;
  const id = resolvePrimarySubjectId(subjects, judge);
  return subjects.find(s => s.id === id)?.description || null;
}

// For each extended ratio, surface the judge's pick on the artifact for
// downstream consumers that don't want to re-derive it from the scores map.
function deriveSelectedWinners(candidates, judge) {
  const out = {};
  for (const ratio of Object.keys(candidates || {})) {
    const judgeWinner = judge?.[ratio]?.winnerId || null;
    if (judgeWinner) {
      out[ratio] = { candidateId: judgeWinner, source: 'judge' };
    }
  }
  return out;
}

// Update Media.latestArtifacts to point at the freshest artifacts. Skip slots
// where the run produced nothing (preserve any existing pointer from a prior
// successful run rather than clearing it).
async function updateMediaLatestArtifacts(media, ids) {
  const existing = media.latestArtifacts || {};
  media.latestArtifacts = {
    detection:    ids.detection    || existing.detection    || null,
    crops:        ids.crops        || existing.crops        || null,
    extended:     ids.extended     || existing.extended     || null,
    match:        ids.match        || existing.match        || null,
    overlayZones: ids.overlayZones || existing.overlayZones || null
  };
  await media.save();
}

module.exports = { processDetectRun };
