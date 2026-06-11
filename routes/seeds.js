// Seed-usage aggregation for the wizard ribbons.
//
// GET /api/seeds/usage?brandId=X[&campaignKind=brand|product][&productIds=a,b][&mediaIds=c,d]
//
// Returns per-seed concept-usage state so the wizard can show
//   ●●○○  2 of 4 directions used; 2 fresh angles available
//   3 ADS  3 ads rendered against this seed
// Each entry mirrors what the wizard tile needs to render:
//
//   {
//     seedKind:          'product' | 'media',
//     seedId:            <productId or mediaId>,
//     adCount:           total AiCanvasArtifact rows keyed to this seed
//     conceptsTotal:     the brand's Director N (capped via env)
//     conceptsUsed:      distinct directionConceptId count across those canvases
//     conceptsUsedIds:   ['cd_...', ...]
//     conceptsRemaining: [{ id, name }] — the Director concepts NOT yet rendered
//     campaignIds:       distinct campaign ids those ads belong to
//   }
//
// Brand campaigns key on mediaId; product campaigns key on productId. Both can
// be requested in one call; the response is a flat array.

const express  = require('express');
const mongoose = require('mongoose');
const router   = express.Router();

const AiCanvasArtifact          = require('../models/AiCanvasArtifact');
const CreativeDirectionArtifact = require('../models/CreativeDirectionArtifact');
const Ad                        = require('../models/Ad');

function toObjectIdArr(csv) {
  if (!csv) return [];
  return String(csv).split(',').map(s => s.trim()).filter(Boolean)
    .filter(s => mongoose.Types.ObjectId.isValid(s))
    .map(s => new mongoose.Types.ObjectId(s));
}

router.get('/usage', async (req, res) => {
  try {
    const brandId = req.query.brandId;
    if (!brandId || !mongoose.Types.ObjectId.isValid(brandId)) {
      return res.status(400).json({ error: 'brandId required' });
    }
    const brandOid     = new mongoose.Types.ObjectId(brandId);
    const productOids  = toObjectIdArr(req.query.productIds);
    const mediaOids    = toObjectIdArr(req.query.mediaIds);
    const campaignKind = req.query.campaignKind || null;     // 'brand' | 'product' | null

    if (!productOids.length && !mediaOids.length) {
      return res.json({ seeds: [] });
    }

    const results = [];

    if (productOids.length) {
      results.push(...await aggregateByProduct(brandOid, productOids, campaignKind));
    }
    if (mediaOids.length) {
      results.push(...await aggregateByMedia(brandOid, mediaOids, campaignKind));
    }

    res.json({ seeds: results });
  } catch (err) {
    console.error(`❌ GET /api/seeds/usage failed: ${err.message}\n${err.stack || ''}`);
    res.status(500).json({ error: err.message || 'seeds usage failed' });
  }
});

// Per-product aggregate. Counts canvases keyed by productId, distinct on
// directionConceptId. Pulls the matching CreativeDirectionArtifact for
// conceptsTotal + the concept-id → name mapping used for the tooltip.
async function aggregateByProduct(brandOid, productOids, campaignKind) {
  // Pre-load Director artifacts for each product so we can derive
  // conceptsTotal + remaining names. Filter by campaignKind when set.
  const dirFilter = {
    brandId:  brandOid,
    productId: { $in: productOids }
  };
  if (campaignKind) dirFilter.campaignKind = campaignKind;

  const directions = await CreativeDirectionArtifact.find(dirFilter)
    .sort({ createdAt: -1 })
    .select('productId campaignKind concepts.concept_id concepts.name')
    .lean();

  // Most-recent Director wins per (productId, campaignKind) — we
  // dedupe on productId since campaignKind is already filtered.
  const directionByProduct = new Map();
  for (const d of directions) {
    const k = String(d.productId);
    if (!directionByProduct.has(k)) directionByProduct.set(k, d);
  }

  // Aggregate canvases by productId, collect distinct concept ids
  // and campaign ids.
  const canvasAgg = await AiCanvasArtifact.aggregate([
    { $match: { brandId: brandOid, productId: { $in: productOids } } },
    { $group: {
        _id: '$productId',
        adCount:       { $sum: 1 },
        conceptsUsed:  { $addToSet: '$directionConceptId' }
    } }
  ]);
  const canvasByProduct = new Map(canvasAgg.map(r => [String(r._id), r]));

  // Campaign ids — pulled from Ad collection (canvases aren't keyed
  // to a campaign; Ads are). Same product → may belong to multiple
  // campaigns.
  const adAgg = await Ad.aggregate([
    { $match: { brandId: brandOid, productId: { $in: productOids } } },
    { $group: { _id: '$productId', campaignIds: { $addToSet: '$campaignId' } } }
  ]);
  const adsByProduct = new Map(adAgg.map(r => [String(r._id), r]));

  const out = [];
  for (const pid of productOids) {
    const k         = String(pid);
    const canvas    = canvasByProduct.get(k);
    const direction = directionByProduct.get(k);
    const ads       = adsByProduct.get(k);
    const concepts  = direction?.concepts || [];

    // De-null the used set in case some canvases lacked directionConceptId (V1 rows).
    const usedIds = (canvas?.conceptsUsed || []).filter(Boolean);
    const usedSet = new Set(usedIds);
    const remaining = concepts.filter(c => !usedSet.has(c.concept_id));

    out.push({
      seedKind:          'product',
      seedId:            String(pid),
      adCount:           canvas?.adCount  || 0,
      conceptsTotal:     concepts.length,
      conceptsUsed:      usedIds.length,
      conceptsUsedIds:   usedIds,
      conceptsRemaining: remaining.map(c => ({ id: c.concept_id, name: c.name || c.concept_id })),
      campaignIds:       (ads?.campaignIds || []).map(String)
    });
  }
  return out;
}

// Per-media aggregate. For brand campaigns the seed identity IS the
// mediaId; the Director still keys on (brand, productId) so we look
// up the most-recent matching Director for the brand WITHOUT a
// productId filter (campaignKind='brand' Directors are emitted with
// the canvas's productId, but we want the count of distinct concepts
// the operator has touched against THIS media regardless of which
// product was attached).
async function aggregateByMedia(brandOid, mediaOids, campaignKind) {
  const canvasAgg = await AiCanvasArtifact.aggregate([
    { $match: { brandId: brandOid, mediaId: { $in: mediaOids } } },
    { $group: {
        _id: '$mediaId',
        adCount:       { $sum: 1 },
        conceptsUsed:  { $addToSet: '$directionConceptId' },
        productIds:    { $addToSet: '$productId' }
    } }
  ]);
  const canvasByMedia = new Map(canvasAgg.map(r => [String(r._id), r]));

  const adAgg = await Ad.aggregate([
    { $match: { brandId: brandOid, mediaId: { $in: mediaOids } } },
    { $group: { _id: '$mediaId', campaignIds: { $addToSet: '$campaignId' } } }
  ]);
  const adsByMedia = new Map(adAgg.map(r => [String(r._id), r]));

  // For conceptsTotal on a per-media basis, pull the Director
  // artifacts for the products this media has been paired with.
  // Take the max concept count across those Directors as the
  // "total angles available" — the operator's view is "how many
  // ways can this brand direct an ad?".
  const allProductIds = new Set();
  for (const r of canvasAgg) for (const pid of (r.productIds || [])) if (pid) allProductIds.add(String(pid));

  let directorConcepts = [];
  if (allProductIds.size) {
    const dirFilter = {
      brandId:  brandOid,
      productId: { $in: [...allProductIds].map(s => new mongoose.Types.ObjectId(s)) }
    };
    if (campaignKind) dirFilter.campaignKind = campaignKind;
    const dirs = await CreativeDirectionArtifact.find(dirFilter)
      .sort({ createdAt: -1 })
      .select('concepts.concept_id concepts.name')
      .lean();
    // Pick the Director with the most concepts as a "total angles" reference.
    for (const d of dirs) {
      if ((d.concepts || []).length > directorConcepts.length) directorConcepts = d.concepts;
    }
  }

  const out = [];
  for (const mid of mediaOids) {
    const k       = String(mid);
    const canvas  = canvasByMedia.get(k);
    const ads     = adsByMedia.get(k);
    const usedIds = (canvas?.conceptsUsed || []).filter(Boolean);
    const usedSet = new Set(usedIds);
    const remaining = directorConcepts.filter(c => !usedSet.has(c.concept_id));

    out.push({
      seedKind:          'media',
      seedId:            String(mid),
      adCount:           canvas?.adCount || 0,
      conceptsTotal:     directorConcepts.length,
      conceptsUsed:      usedIds.length,
      conceptsUsedIds:   usedIds,
      conceptsRemaining: remaining.map(c => ({ id: c.concept_id, name: c.name || c.concept_id })),
      campaignIds:       (ads?.campaignIds || []).map(String)
    });
  }
  return out;
}

module.exports = router;
