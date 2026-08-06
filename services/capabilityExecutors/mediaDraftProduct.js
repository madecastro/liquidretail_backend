// Executor for capability media.draftProduct (Tier 1, brand scope).
//
// Manual "save as draft product" escape hatch. Mirrors POST
// /api/media/:mediaId/draft-product — reads the latest
// ProductMatchArtifact for the media and forces a draft CatalogProduct
// write, bypassing the certainty + brand-opt-in guards that gate the
// automatic path. Useful when:
//   - autoCreateFromDetect is OFF but the operator wants this one match
//     in the catalog anyway
//   - the match was below the 0.85 confidence floor but the operator
//     manually verified it's correct

'use strict';

const mongoose = require('mongoose');
const Media = require('../../models/Media');
const ProductMatchArtifact = require('../../models/ProductMatchArtifact');
const { maybeCreateDraftFromMatch } = require('../catalogProductDraftService');

async function run({ req, args }) {
  if (!req?.advertiserId) {
    return { ok: false, error: 'no advertiser scope on request — auth middleware did not run' };
  }
  const rawMediaId = args?.mediaId;
  if (!rawMediaId) return { ok: false, error: 'mediaId required' };
  if (!mongoose.isValidObjectId(rawMediaId)) {
    return { ok: false, error: `mediaId "${rawMediaId}" is not a valid ObjectId` };
  }

  // Tenant guard — Media.advertiserId is the source of truth.
  const media = await Media.findOne({ _id: rawMediaId, advertiserId: req.advertiserId });
  if (!media) return { ok: false, error: `media ${rawMediaId} not found` };

  // Latest match snapshot — same shape the route uses.
  const match = await ProductMatchArtifact.findOne({ mediaId: media._id })
    .sort({ createdAt: -1 })
    .lean();
  if (!match) return { ok: false, error: 'no product match artifact for this media yet — run detect first' };

  const result = await maybeCreateDraftFromMatch({
    media,
    productMatch: {
      outcome:        match.outcome,
      winner:         match.winner,
      identification: match.identification,
      query:          match.query,
      catalogMatch:   match.catalogMatch
    },
    sceneImageUrl: media.fileUrl,
    yoloProducts:  [],
    force:         true
  });

  if (!result?.created) {
    return { ok: false, error: `draft create skipped: ${result?.reason || 'unknown'}` };
  }

  return {
    ok: true,
    kind: 'productDraft',
    data: {
      productId: result.productId ? String(result.productId) : null,
      externalId: result.externalId || null,
      title: result.title || null,
      brandId: media.brandId ? String(media.brandId) : null,
      mediaId: String(media._id),
      note: 'Draft row landed in the catalog. Complete price + productUrl to promote it out of the drafts queue.'
    }
  };
}

module.exports = { run };
